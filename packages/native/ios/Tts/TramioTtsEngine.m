//
//  TramioTtsEngine.m
//  @tramio/native — TTS_Engine iOS native side (task 8.5)
//
//  Implementation notes:
//
//  - Voice resolution mirrors the JS-side `resolveVoice` helper exactly so
//    the four-step fallback chain stays consistent across platforms.
//    Native lookups go through:
//      step 1: scan `AVSpeechSynthesisVoice.speechVoices` for (language, region)
//      step 2: scan `AVSpeechSynthesisVoice.speechVoices` for language only
//      step 3: `AVSpeechSynthesisVoice.speechVoiceForLanguage:` on the
//              requested BCP-47 string
//      step 4: same lookup against the bundle's defaultLanguage
//
//  - Each fallback step that misses logs via `os_log` with `OS_LOG_TYPE_INFO`
//    so the warning is surfaced in Console.app without being treated as an
//    error (Req 9.4 "non-fatal warning").
//
//  - Playback events are emitted by `AVSpeechSynthesizerDelegate` callbacks.
//    `speechSynthesizer:didFinishSpeechUtterance:` and
//    `speechSynthesizer:didCancelSpeechUtterance:` both fire
//    `onPlaybackFinished` so the engine's `AudioFinished` event arrives
//    on either path; `didCancel` is what `stop` produces and the engine's
//    reducer should treat it as a finish (Req 1.7 "release within 2s").
//
//  - Audio focus is tracked via `AVAudioSessionInterruptionNotification`,
//    the same notification Audio_Service hooks. The class registers and
//    unregisters in `init` / `dealloc` so a single TramioTtsEngine
//    instance owns the lifetime of its observer.
//
//  - This module deliberately does NOT manage `AVAudioSession` category
//    activation; Audio_Service owns that and is the single writer for the
//    process. Picking an explicit category here would race Audio_Service.
//

#import "TramioTtsEngine.h"
#import <AVFoundation/AVFoundation.h>
#import <os/log.h>

NSString *const kTramioTtsEventPlaybackFinished = @"onPlaybackFinished";
NSString *const kTramioTtsEventFocusLoss        = @"onFocusLoss";
NSString *const kTramioTtsEventFocusRegain      = @"onFocusRegain";

NSString *const kTramioTtsOptionSegmentId       = @"segmentId";
NSString *const kTramioTtsOptionLanguage        = @"language";
NSString *const kTramioTtsOptionRegion          = @"region";
NSString *const kTramioTtsOptionDefaultLanguage = @"defaultLanguage";
NSString *const kTramioTtsOptionRate            = @"rate";
NSString *const kTramioTtsOptionPitch           = @"pitch";
NSString *const kTramioTtsOptionVolume          = @"volume";

static os_log_t TramioTtsLog(void) {
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    log = os_log_create("app.tramio.client", "TtsEngine");
  });
  return log;
}

#pragma mark - Voice resolution

typedef NS_ENUM(NSInteger, TramioTtsResolveStep) {
  TramioTtsResolveStepExactLanguageRegion = 1,
  TramioTtsResolveStepExactLanguage,
  TramioTtsResolveStepPlatformDefaultLanguage,
  TramioTtsResolveStepPlatformDefaultDefaultLanguage,
  TramioTtsResolveStepNoVoiceAvailable,
};

@interface TramioTtsResolution : NSObject
@property (nonatomic, strong, nullable) AVSpeechSynthesisVoice *voice;
@property (nonatomic, assign) TramioTtsResolveStep step;
@end

@implementation TramioTtsResolution
@end

static NSString *NormalizeLang(NSString *_Nullable tag) {
  return [[tag stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] lowercaseString] ?: @"";
}

static NSString *NormalizeRegion(NSString *_Nullable tag) {
  if (tag == nil) return @"";
  return [[tag stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]] uppercaseString] ?: @"";
}

/// Split `AVSpeechSynthesisVoice.language` (BCP-47, e.g. "en-GB") into
/// (language, region). Returns the lower-cased language and upper-cased
/// region; region may be `nil`.
static void SplitLang(NSString *bcp47, NSString *__autoreleasing *outLang, NSString *__autoreleasing *outRegion) {
  NSArray<NSString *> *parts = [bcp47 componentsSeparatedByString:@"-"];
  *outLang = parts.count > 0 ? [parts[0] lowercaseString] : @"";
  *outRegion = parts.count > 1 ? [parts[1] uppercaseString] : nil;
}

static AVSpeechSynthesisVoice *_Nullable MatchExactLanguageRegion(NSArray<AVSpeechSynthesisVoice *> *voices,
                                                                  NSString *language,
                                                                  NSString *_Nullable region) {
  if (region == nil || region.length == 0) return nil;
  for (AVSpeechSynthesisVoice *v in voices) {
    NSString *vLang = nil;
    NSString *vRegion = nil;
    SplitLang(v.language, &vLang, &vRegion);
    if ([vLang isEqualToString:language] && vRegion != nil && [vRegion isEqualToString:region]) {
      return v;
    }
  }
  return nil;
}

static AVSpeechSynthesisVoice *_Nullable MatchExactLanguage(NSArray<AVSpeechSynthesisVoice *> *voices,
                                                            NSString *language) {
  AVSpeechSynthesisVoice *firstMatch = nil;
  for (AVSpeechSynthesisVoice *v in voices) {
    NSString *vLang = nil;
    NSString *vRegion = nil;
    SplitLang(v.language, &vLang, &vRegion);
    if (![vLang isEqualToString:language]) continue;
    // AVSpeechSynthesisVoice doesn't expose an explicit "is platform default"
    // flag; we fall back to the first match in iteration order.
    if (firstMatch == nil) firstMatch = v;
  }
  return firstMatch;
}

/// Build a BCP-47 tag from `(language, region)`. Returns `language` alone
/// when no region is supplied. Used to call
/// `AVSpeechSynthesisVoice.speechVoiceForLanguage:` which expects BCP-47.
static NSString *BuildBcp47(NSString *language, NSString *_Nullable region) {
  if (region == nil || region.length == 0) return language;
  return [NSString stringWithFormat:@"%@-%@", language, region];
}

/// Resolve a voice using the four-step fallback chain. Each miss logs a
/// non-fatal warning via `os_log`. Mirrors `packages/native/src/tts/resolveVoice.ts`.
static TramioTtsResolution *ResolveVoice(NSString *requestedLanguage,
                                         NSString *_Nullable requestedRegion,
                                         NSString *defaultLanguage) {
  NSString *lang = NormalizeLang(requestedLanguage);
  NSString *region = requestedRegion != nil ? NormalizeRegion(requestedRegion) : nil;
  if (region != nil && region.length == 0) region = nil;
  NSString *defLang = NormalizeLang(defaultLanguage);

  NSArray<AVSpeechSynthesisVoice *> *allVoices = [AVSpeechSynthesisVoice speechVoices];
  TramioTtsResolution *result = [TramioTtsResolution new];

  // Step 1: exact (language, region).
  if (region != nil) {
    AVSpeechSynthesisVoice *v = MatchExactLanguageRegion(allVoices, lang, region);
    if (v != nil) {
      result.voice = v;
      result.step = TramioTtsResolveStepExactLanguageRegion;
      return result;
    }
    os_log_info(TramioTtsLog(),
                "TTS_Engine: no voice matched (language=%{public}@, region=%{public}@); falling back to language-only match",
                lang, region);
  }

  // Step 2: exact language match.
  {
    AVSpeechSynthesisVoice *v = MatchExactLanguage(allVoices, lang);
    if (v != nil) {
      result.voice = v;
      result.step = TramioTtsResolveStepExactLanguage;
      return result;
    }
    os_log_info(TramioTtsLog(),
                "TTS_Engine: no voice matched language=%{public}@; falling back to platform default for language",
                lang);
  }

  // Step 3: platform default for the requested language.
  {
    AVSpeechSynthesisVoice *v = [AVSpeechSynthesisVoice voiceWithLanguage:BuildBcp47(lang, region)];
    if (v != nil) {
      result.voice = v;
      result.step = TramioTtsResolveStepPlatformDefaultLanguage;
      return result;
    }
    os_log_info(TramioTtsLog(),
                "TTS_Engine: no platform default for language=%{public}@; falling back to platform default for defaultLanguage=%{public}@",
                lang, defLang);
  }

  // Step 4: platform default for the bundle's defaultLanguage.
  {
    AVSpeechSynthesisVoice *v = [AVSpeechSynthesisVoice voiceWithLanguage:defLang];
    if (v != nil) {
      result.voice = v;
      result.step = TramioTtsResolveStepPlatformDefaultDefaultLanguage;
      return result;
    }
    // Last-resort scan over all voices for the default language.
    AVSpeechSynthesisVoice *anyDefault = MatchExactLanguage(allVoices, defLang);
    if (anyDefault != nil) {
      result.voice = anyDefault;
      result.step = TramioTtsResolveStepPlatformDefaultDefaultLanguage;
      return result;
    }
    os_log_info(TramioTtsLog(),
                "TTS_Engine: no voice available for defaultLanguage=%{public}@; falling through to AVSpeechSynthesizer's any-voice path",
                defLang);
  }

  result.voice = nil;
  result.step = TramioTtsResolveStepNoVoiceAvailable;
  return result;
}

#pragma mark - Module

@interface TramioTtsEngine () <AVSpeechSynthesizerDelegate>
@property (nonatomic, strong) AVSpeechSynthesizer *synthesizer;
@property (nonatomic, strong, nullable) NSString *currentSegmentId;
@property (nonatomic, assign) BOOL hasJSListeners;
@property (nonatomic, strong, nullable) id audioInterruptionObserver;
@end

@implementation TramioTtsEngine

RCT_EXPORT_MODULE(TramioTtsEngine)

+ (BOOL)requiresMainQueueSetup {
  // AVSpeechSynthesizer must be created on the main thread; the documented
  // RCT contract treats this hint as gospel for module init.
  return YES;
}

- (instancetype)init {
  if ((self = [super init])) {
    _synthesizer = [AVSpeechSynthesizer new];
    _synthesizer.delegate = self;
    _hasJSListeners = NO;
    [self subscribeToAudioFocus];
  }
  return self;
}

- (void)dealloc {
  [self unsubscribeFromAudioFocus];
  // Defensive: cancel anything in-flight so the synthesizer doesn't keep
  // a strong-ref cycle on this object via its delegate.
  if (_synthesizer.isSpeaking || _synthesizer.isPaused) {
    [_synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
  _synthesizer.delegate = nil;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[
    kTramioTtsEventPlaybackFinished,
    kTramioTtsEventFocusLoss,
    kTramioTtsEventFocusRegain,
  ];
}

- (void)startObserving {
  self.hasJSListeners = YES;
}

- (void)stopObserving {
  self.hasJSListeners = NO;
}

- (dispatch_queue_t)methodQueue {
  // AVSpeechSynthesizer is main-thread bound; pin every bridge call to
  // main so utterance lifecycle is deterministic.
  return dispatch_get_main_queue();
}

#pragma mark - Audio focus piggyback

- (void)subscribeToAudioFocus {
  __weak __typeof(self) weakSelf = self;
  self.audioInterruptionObserver = [[NSNotificationCenter defaultCenter]
    addObserverForName:AVAudioSessionInterruptionNotification
                object:[AVAudioSession sharedInstance]
                 queue:[NSOperationQueue mainQueue]
            usingBlock:^(NSNotification * _Nonnull note) {
    __strong __typeof(weakSelf) strongSelf = weakSelf;
    if (strongSelf == nil || !strongSelf.hasJSListeners) return;
    NSNumber *typeNumber = note.userInfo[AVAudioSessionInterruptionTypeKey];
    if (typeNumber == nil) return;
    AVAudioSessionInterruptionType type =
        (AVAudioSessionInterruptionType)typeNumber.unsignedIntegerValue;
    switch (type) {
      case AVAudioSessionInterruptionTypeBegan:
        // Pause to keep the offset capture story consistent with
        // Audio_Service (Req 10.1). The engine reducer treats FocusLoss
        // as the source of truth for pausing playback.
        if (strongSelf.synthesizer.isSpeaking) {
          [strongSelf.synthesizer pauseSpeakingAtBoundary:AVSpeechBoundaryImmediate];
        }
        [strongSelf sendEventWithName:kTramioTtsEventFocusLoss body:@{}];
        break;
      case AVAudioSessionInterruptionTypeEnded:
        [strongSelf sendEventWithName:kTramioTtsEventFocusRegain body:@{}];
        break;
    }
  }];
}

- (void)unsubscribeFromAudioFocus {
  if (self.audioInterruptionObserver != nil) {
    [[NSNotificationCenter defaultCenter] removeObserver:self.audioInterruptionObserver];
    self.audioInterruptionObserver = nil;
  }
}

#pragma mark - Bridge methods

RCT_EXPORT_METHOD(speak:(NSString *)text
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *segmentId = options[kTramioTtsOptionSegmentId];
  NSString *language = options[kTramioTtsOptionLanguage];
  NSString *defaultLanguage = options[kTramioTtsOptionDefaultLanguage];
  if (segmentId.length == 0 || language.length == 0 || defaultLanguage.length == 0) {
    reject(@"E_TTS_ARGUMENTS",
           @"speak requires segmentId, language, defaultLanguage", nil);
    return;
  }
  NSString *_Nullable region = options[kTramioTtsOptionRegion];

  TramioTtsResolution *resolution = ResolveVoice(language, region, defaultLanguage);
  AVSpeechUtterance *utterance = [[AVSpeechUtterance alloc] initWithString:text];
  utterance.voice = resolution.voice; // nil is acceptable; AVSpeechSynthesizer
                                      // falls through to its any-voice path.

  NSNumber *rate = options[kTramioTtsOptionRate];
  if ([rate isKindOfClass:[NSNumber class]]) {
    // AVSpeechUtteranceDefaultSpeechRate is documented; we map the
    // engine's [0.75..1.5] band onto the platform's actual usable range
    // by anchoring at default and clamping.
    float platformDefault = AVSpeechUtteranceDefaultSpeechRate;
    float requested = rate.floatValue;
    float clamped = MAX(AVSpeechUtteranceMinimumSpeechRate,
                        MIN(AVSpeechUtteranceMaximumSpeechRate,
                            platformDefault * requested));
    utterance.rate = clamped;
  }
  NSNumber *pitch = options[kTramioTtsOptionPitch];
  if ([pitch isKindOfClass:[NSNumber class]]) {
    utterance.pitchMultiplier = MAX(0.5f, MIN(2.0f, pitch.floatValue));
  }
  NSNumber *volume = options[kTramioTtsOptionVolume];
  if ([volume isKindOfClass:[NSNumber class]]) {
    utterance.volume = MAX(0.0f, MIN(1.0f, volume.floatValue));
  }

  // Cancel anything in flight to honour the engine's single-segment
  // invariant (`|playing| <= 1`, design.md). The cancellation path
  // emits a `didCancel` -> PlaybackFinished for the prior segment so
  // the engine reducer sees the transition cleanly.
  if (self.synthesizer.isSpeaking || self.synthesizer.isPaused) {
    [self.synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }

  self.currentSegmentId = segmentId;
  [self.synthesizer speakUtterance:utterance];
  resolve(@{});
}

RCT_EXPORT_METHOD(pause:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (self.synthesizer.isSpeaking) {
    [self.synthesizer pauseSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
  resolve(@{});
}

RCT_EXPORT_METHOD(resume:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (self.synthesizer.isPaused) {
    [self.synthesizer continueSpeaking];
  }
  resolve(@{});
}

RCT_EXPORT_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (self.synthesizer.isSpeaking || self.synthesizer.isPaused) {
    [self.synthesizer stopSpeakingAtBoundary:AVSpeechBoundaryImmediate];
  }
  resolve(@{});
}

#pragma mark - AVSpeechSynthesizerDelegate

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  didFinishSpeechUtterance:(AVSpeechUtterance *)utterance
{
  [self emitPlaybackFinished];
}

- (void)speechSynthesizer:(AVSpeechSynthesizer *)synthesizer
  didCancelSpeechUtterance:(AVSpeechUtterance *)utterance
{
  // The engine treats cancel and finish identically (Req 1.7 release-on-end).
  [self emitPlaybackFinished];
}

- (void)emitPlaybackFinished {
  if (!self.hasJSListeners) {
    self.currentSegmentId = nil;
    return;
  }
  NSString *segmentId = self.currentSegmentId ?: @"";
  self.currentSegmentId = nil;
  [self sendEventWithName:kTramioTtsEventPlaybackFinished
                     body:@{ kTramioTtsOptionSegmentId : segmentId }];
}

@end
