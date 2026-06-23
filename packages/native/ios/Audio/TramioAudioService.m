// TramioAudioService.m
//
// iOS native implementation of the Audio_Service turbo module
// (task 8.3). See TramioAudioService.h for the contract description.
//
// What this file does NOT do (scoped out of the MVP per the task brief):
//   * Real LUFS measurement. Loudness target is approximated via a
//     per-segment `gainOffsetDb` parameter applied as a linear gain
//     on top of nominal volume; the ±3 dB tolerance described in
//     Requirement 9.3 is the catalog's responsibility to honor.
//   * Encrypted-stream playback through AVAssetResourceLoaderDelegate.
//     The TS surface exposes a `DecryptStreamHandle` parameter (see
//     `packages/native/src/audio/types.ts`) so task 13.1 can wire the
//     Crypto_Service streaming-decrypt path without changing this
//     interface; the URL fast path is what's wired today.
//
// Plaintext-free playback (design.md "Audio_Service > Plaintext-free
// playback path") is implemented by deferring stream resolution to a
// follow-up integration task. The handle string is parsed here and an
// NSError is surfaced to JS as a `PlaybackFinished` event with
// `reason: "error"` if the resolver is not yet installed. This keeps
// the JS-side engine progressing even when the secure path is wired
// piecewise.

#import "TramioAudioService.h"

#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>

NSString *const kTramioAudioServiceModuleName = @"TramioAudioService";
NSString *const kTramioAudioEventPlaybackFinished = @"onPlaybackFinished";
NSString *const kTramioAudioEventFocusLoss = @"onFocusLoss";
NSString *const kTramioAudioEventFocusRegain = @"onFocusRegain";
NSString *const kTramioAudioEventDuckingChange = @"onDuckingChange";

// LUFS knob bounds. Mirrors GAIN_OFFSET_DB_{MIN,MAX} in
// packages/native/src/audio/NativeAudioService.ts.
static const double kTramioGainOffsetDbMin = -12.0;
static const double kTramioGainOffsetDbMax = 12.0;

// Duck percent bounds. Mirrors DUCK_PERCENT_{MIN,MAX} in TS.
static const double kTramioDuckPercentMin = 0.0;
static const double kTramioDuckPercentMax = 100.0;

@interface TramioAudioService () <AVAudioPlayerDelegate>

/// Currently-playing segment ID (matches the JS `segmentId`).
/// nil while idle; set under `play` and cleared on stop / completion.
@property (nonatomic, copy, nullable) NSString *currentSegmentId;

/// Backing player. AVAudioPlayer is sufficient for the MVP because the
/// pre-rendered audio assets we ship are short, fully buffered files.
/// AVPlayer + AVAssetResourceLoaderDelegate is the upgrade path for
/// streamed-decrypt playback (task 13.1).
@property (nonatomic, strong, nullable) AVAudioPlayer *player;

/// Per-segment gain offset (dB) most recently applied. Cached so the
/// duck calculation can compose with it without rereading from the
/// caller.
@property (nonatomic, assign) double currentGainOffsetDb;

/// Most recent ducking level [0, 100]. 0 means full nominal volume.
@property (nonatomic, assign) double currentDuckPercent;

/// Whether JS has at least one event listener attached. The
/// RCTEventEmitter base class enforces no events fire until JS is
/// listening; we track the boolean for our own logging.
@property (nonatomic, assign) BOOL hasListeners;

/// AVAudioSession reference held for the module's lifetime.
@property (nonatomic, strong, readonly) AVAudioSession *session;

@end

@implementation TramioAudioService

RCT_EXPORT_MODULE(TramioAudioService);

#pragma mark - RCTEventEmitter

- (instancetype)init {
  self = [super init];
  if (self) {
    _session = [AVAudioSession sharedInstance];
    _currentGainOffsetDb = 0.0;
    _currentDuckPercent = 0.0;
    [self configureAudioSession];
    [self subscribeToInterruptions];
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[
    kTramioAudioEventPlaybackFinished,
    kTramioAudioEventFocusLoss,
    kTramioAudioEventFocusRegain,
    kTramioAudioEventDuckingChange,
  ];
}

- (void)startObserving {
  self.hasListeners = YES;
}

- (void)stopObserving {
  self.hasListeners = NO;
}

+ (BOOL)requiresMainQueueSetup {
  // AVAudioSession configuration is safe off the main queue, but
  // AVAudioPlayer construction wants its delegate calls scheduled on a
  // run loop. Returning YES here (a) ensures the module is constructed
  // on the main queue at module-init time and (b) keeps the delegate
  // callbacks on the main queue too. This is consistent with what
  // most RN audio modules do in practice.
  return YES;
}

#pragma mark - AVAudioSession setup

- (void)configureAudioSession {
  NSError *error = nil;
  // .playback category + mixWithOthers: false. The "background audio"
  // capability declared in app.config.ts requires the playback category
  // be set before an audio item starts producing samples; we do it
  // eagerly here so the very first `play` call doesn't lose its first
  // ~50 ms while the session activates.
  AVAudioSessionCategoryOptions options = 0;  // mixWithOthers explicitly off.
  BOOL ok = [self.session setCategory:AVAudioSessionCategoryPlayback
                          withOptions:options
                                error:&error];
  if (!ok) {
    RCTLogError(@"[TramioAudioService] setCategory failed: %@", error);
  }
  // We do NOT setActive:YES here: AVAudioSession activation while no
  // audio is playing will wake competing apps. The session is
  // activated lazily inside `play`.
}

#pragma mark - Interruption (focus loss / regain)

- (void)subscribeToInterruptions {
  [[NSNotificationCenter defaultCenter]
      addObserver:self
         selector:@selector(handleInterruption:)
             name:AVAudioSessionInterruptionNotification
           object:self.session];
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  [self.player stop];
  self.player = nil;
}

- (void)handleInterruption:(NSNotification *)notification {
  NSDictionary *info = notification.userInfo;
  if (info == nil) return;
  NSNumber *typeNum = info[AVAudioSessionInterruptionTypeKey];
  if (typeNum == nil) return;
  AVAudioSessionInterruptionType type =
      (AVAudioSessionInterruptionType)typeNum.unsignedIntegerValue;

  if (type == AVAudioSessionInterruptionTypeBegan) {
    // Pause and capture the offset (Req 10.1). The JS engine reads the
    // captured offset and drives `resume(offsetMs)` on focus regain.
    NSTimeInterval offsetSec = self.player ? self.player.currentTime : 0.0;
    NSInteger capturedOffsetMs = (NSInteger)(offsetSec * 1000.0);
    [self.player pause];
    [self emitEvent:kTramioAudioEventFocusLoss
               body:[self focusLossBodyWithOffsetMs:capturedOffsetMs]];
  } else if (type == AVAudioSessionInterruptionTypeEnded) {
    // Per Req 10.2 we resume from the captured offset, but we let the
    // JS engine drive the resume call so the 10-minute discard rule
    // (Req 10.3) and the entitlement / state-machine checks all run
    // through the reducer. We just announce the regain.
    [self emitEvent:kTramioAudioEventFocusRegain
               body:[self focusRegainBody]];
  }
}

- (NSDictionary *)focusLossBodyWithOffsetMs:(NSInteger)offsetMs {
  NSMutableDictionary *body = [NSMutableDictionary dictionaryWithCapacity:2];
  body[@"capturedOffsetMs"] = @(offsetMs);
  if (self.currentSegmentId != nil) {
    body[@"segmentId"] = self.currentSegmentId;
  }
  return [body copy];
}

- (NSDictionary *)focusRegainBody {
  NSMutableDictionary *body = [NSMutableDictionary dictionaryWithCapacity:1];
  if (self.currentSegmentId != nil) {
    body[@"segmentId"] = self.currentSegmentId;
  }
  return [body copy];
}

#pragma mark - Exported methods (Spec)

// play(segmentId, sourceJson, optsJson) -> Promise<void>
RCT_EXPORT_METHOD(play:(NSString *)segmentId
                  sourceJson:(NSString *)sourceJson
                  optsJson:(NSString *)optsJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *parseError = nil;
  NSDictionary *source = [self parseJsonObject:sourceJson error:&parseError];
  if (source == nil) {
    reject(@"E_AUDIO_SOURCE", @"Invalid sourceJson", parseError);
    return;
  }
  NSDictionary *opts = [self parseJsonObject:optsJson error:&parseError];
  if (opts == nil) {
    reject(@"E_AUDIO_OPTS", @"Invalid optsJson", parseError);
    return;
  }

  // Stop any prior segment to honor the |playing| <= 1 invariant.
  [self stopInternal];

  NSURL *url = [self resolveSourceUrl:source segmentId:segmentId];
  if (url == nil) {
    // No URL means the source was a stream handle and the streaming
    // decrypt resolver isn't installed yet (task 13.1). Surface a
    // synthetic PlaybackFinished{error} so the engine can advance
    // rather than waiting forever for completion.
    [self emitEvent:kTramioAudioEventPlaybackFinished
               body:@{
                 @"segmentId": segmentId,
                 @"reason": @"error",
                 @"errorMessage": @"DecryptStreamHandle resolver not yet wired (task 13.1)",
               }];
    resolve(nil);
    return;
  }

  NSError *playerError = nil;
  AVAudioPlayer *player = [[AVAudioPlayer alloc] initWithContentsOfURL:url error:&playerError];
  if (player == nil) {
    reject(@"E_AUDIO_PLAYER_INIT", @"Failed to construct AVAudioPlayer", playerError);
    return;
  }
  player.delegate = self;
  [player prepareToPlay];

  double startOffsetMs = [self doubleFromOpts:opts key:@"startOffsetMs" fallback:0.0];
  double gainOffsetDb = [self doubleFromOpts:opts key:@"gainOffsetDb" fallback:0.0];
  double duckPercent = [self doubleFromOpts:opts key:@"initialDuckPercent" fallback:0.0];

  gainOffsetDb = [self clamp:gainOffsetDb min:kTramioGainOffsetDbMin max:kTramioGainOffsetDbMax];
  duckPercent = [self clamp:duckPercent min:kTramioDuckPercentMin max:kTramioDuckPercentMax];

  if (startOffsetMs > 0.0) {
    player.currentTime = startOffsetMs / 1000.0;
  }

  self.currentSegmentId = segmentId;
  self.player = player;
  self.currentGainOffsetDb = gainOffsetDb;
  self.currentDuckPercent = duckPercent;
  [self applyVolume];

  // Activate the session lazily so we don't preempt other apps when
  // idle. iOS will keep us alive in the background under the `audio`
  // mode declared in app.config.ts.
  NSError *activateError = nil;
  if (![self.session setActive:YES error:&activateError]) {
    RCTLogWarn(@"[TramioAudioService] setActive:YES failed: %@", activateError);
  }

  [player play];
  resolve(nil);
}

// pause() -> Promise<number> (captured offset in ms)
RCT_EXPORT_METHOD(pause:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (self.player == nil) {
    resolve(@0);
    return;
  }
  NSTimeInterval offsetSec = self.player.currentTime;
  [self.player pause];
  NSInteger offsetMs = (NSInteger)(offsetSec * 1000.0);
  resolve(@(offsetMs));
}

// resume(offsetMs) -> Promise<void>
RCT_EXPORT_METHOD(resume:(double)offsetMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  if (self.player == nil) {
    // Idempotent: nothing to resume.
    resolve(nil);
    return;
  }
  double clean = offsetMs < 0.0 ? 0.0 : offsetMs;
  self.player.currentTime = clean / 1000.0;
  [self.player play];
  resolve(nil);
}

// stop() -> Promise<void>
RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  [self stopInternal];
  resolve(nil);
}

// duck(percent) -> Promise<void>
RCT_EXPORT_METHOD(duck:(double)percent
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  double clean = [self clamp:percent min:kTramioDuckPercentMin max:kTramioDuckPercentMax];
  self.currentDuckPercent = clean;
  [self applyVolume];
  [self emitEvent:kTramioAudioEventDuckingChange body:@{ @"percent": @(clean) }];
  resolve(nil);
}

#pragma mark - Listener token bridge
//
// The TS spec exposes addXxxListener / removeListener returning string
// tokens. RCTEventEmitter does not natively model per-call tokens, so
// the JS wrapper uses our generated token strings only as a handle to
// pair `on`/`off` calls. The native side itself fans out via
// RCTEventEmitter.sendEventWithName, and `removeListener` is a no-op
// here because the JS subscription lives on the JS side.

RCT_EXPORT_METHOD(addPlaybackFinishedListener:(RCTResponseSenderBlock)callback) {
  callback(@[ [self issueTokenForKind:@"PlaybackFinished"] ]);
}
RCT_EXPORT_METHOD(addFocusLossListener:(RCTResponseSenderBlock)callback) {
  callback(@[ [self issueTokenForKind:@"FocusLoss"] ]);
}
RCT_EXPORT_METHOD(addFocusRegainListener:(RCTResponseSenderBlock)callback) {
  callback(@[ [self issueTokenForKind:@"FocusRegain"] ]);
}
RCT_EXPORT_METHOD(addDuckingChangeListener:(RCTResponseSenderBlock)callback) {
  callback(@[ [self issueTokenForKind:@"DuckingChange"] ]);
}
RCT_EXPORT_METHOD(removeListener:(NSString *)token) {
  // Tokens are tracked on the JS side; nothing to free here.
  (void)token;
}

#pragma mark - AVAudioPlayerDelegate

- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag {
  NSString *segmentId = self.currentSegmentId;
  if (segmentId == nil) return;
  self.currentSegmentId = nil;
  self.player = nil;
  [self emitEvent:kTramioAudioEventPlaybackFinished
             body:@{
               @"segmentId": segmentId,
               @"reason": flag ? @"completed" : @"error",
             }];
}

- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError *)error {
  NSString *segmentId = self.currentSegmentId ?: @"";
  self.currentSegmentId = nil;
  self.player = nil;
  [self emitEvent:kTramioAudioEventPlaybackFinished
             body:@{
               @"segmentId": segmentId,
               @"reason": @"error",
               @"errorMessage": error.localizedDescription ?: @"decode error",
             }];
}

#pragma mark - Helpers

- (void)stopInternal {
  if (self.player != nil) {
    [self.player stop];
  }
  self.player = nil;
  self.currentSegmentId = nil;
  // Leave the session active; AVAudioSession docs warn against
  // toggling .active rapidly (it preempts other apps).
}

- (void)applyVolume {
  if (self.player == nil) return;
  // Convert the dB offset to a linear scalar: 10 ** (dB / 20).
  // Then attenuate by the duck percentage (0 means no attenuation).
  double gainScalar = pow(10.0, self.currentGainOffsetDb / 20.0);
  double duckScalar = 1.0 - (self.currentDuckPercent / 100.0);
  if (duckScalar < 0.0) duckScalar = 0.0;
  double finalVolume = gainScalar * duckScalar;
  if (finalVolume > 1.0) finalVolume = 1.0;
  if (finalVolume < 0.0) finalVolume = 0.0;
  self.player.volume = (float)finalVolume;
}

- (NSURL *_Nullable)resolveSourceUrl:(NSDictionary *)source segmentId:(NSString *)segmentId {
  NSString *kind = source[@"kind"];
  if ([kind isEqualToString:@"url"]) {
    NSString *urlString = source[@"url"];
    if (urlString.length == 0) return nil;
    return [NSURL URLWithString:urlString];
  }
  if ([kind isEqualToString:@"stream"]) {
    // The streaming-decrypt resolver is wired in task 13.1.
    return nil;
  }
  return nil;
}

- (NSDictionary *_Nullable)parseJsonObject:(NSString *)json error:(NSError **)errorOut {
  if (json.length == 0) {
    if (errorOut) {
      *errorOut = [NSError errorWithDomain:@"TramioAudioService"
                                      code:1
                                  userInfo:@{ NSLocalizedDescriptionKey: @"empty json" }];
    }
    return nil;
  }
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  if (data == nil) return nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:errorOut];
  if (![parsed isKindOfClass:[NSDictionary class]]) return nil;
  return (NSDictionary *)parsed;
}

- (double)doubleFromOpts:(NSDictionary *)opts key:(NSString *)key fallback:(double)fallback {
  id value = opts[key];
  if ([value isKindOfClass:[NSNumber class]]) {
    return [(NSNumber *)value doubleValue];
  }
  return fallback;
}

- (double)clamp:(double)v min:(double)lo max:(double)hi {
  if (isnan(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

- (NSString *)issueTokenForKind:(NSString *)kind {
  // Token only has to be unique per-process; counter is sufficient.
  static NSInteger counter = 0;
  counter += 1;
  return [NSString stringWithFormat:@"native-%@-%ld", kind, (long)counter];
}

- (void)emitEvent:(NSString *)name body:(id)body {
  if (!self.hasListeners) return;
  [self sendEventWithName:name body:body];
}

@end
