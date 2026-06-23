//
//  TramioTtsEngine.h
//  @tramio/native — TTS_Engine iOS native side (task 8.5)
//
//  Wraps `AVSpeechSynthesizer` (Req 15.1) and exposes the JS-side spec
//  declared in `packages/native/src/tts/NativeTtsEngine.ts`. Voice
//  resolution follows the documented fallback chain in `resolveVoice.ts`:
//
//    1. exact (language, region) match
//    2. exact language match
//    3. platform default voice for the requested language
//       (`AVSpeechSynthesisVoice.speechVoice(forLanguage:)`)
//    4. platform default voice for the bundle's `defaultLanguage`
//
//  On a miss at any step a non-fatal warning is logged via `os_log`
//  (Req 9.4). Playback events are emitted with the same shape as
//  Audio_Service so the engine's command translator (task 13.1) can
//  consume either backend uniformly:
//
//    - onPlaybackFinished : { segmentId }
//    - onFocusLoss        : {}
//    - onFocusRegain      : {}
//
//  Audio focus loss / regain piggybacks the same notifications
//  Audio_Service hooks (`AVAudioSessionInterruptionNotification`).
//

#import <Foundation/Foundation.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/// Event names emitted via `RCTEventEmitter`. They match the JS-side
/// `TtsPlaybackEvent.kind` discriminator vocabulary.
extern NSString *const kTramioTtsEventPlaybackFinished;
extern NSString *const kTramioTtsEventFocusLoss;
extern NSString *const kTramioTtsEventFocusRegain;

/// Parameter keys accepted by `speak:options:resolve:reject:`. See
/// `SpeakOptions` in the JS-side spec.
extern NSString *const kTramioTtsOptionSegmentId;       // required, NSString
extern NSString *const kTramioTtsOptionLanguage;        // required, NSString (ISO 639-1)
extern NSString *const kTramioTtsOptionRegion;          // optional, NSString (ISO 3166-1)
extern NSString *const kTramioTtsOptionDefaultLanguage; // required, NSString (manifest default)
extern NSString *const kTramioTtsOptionRate;            // optional, NSNumber
extern NSString *const kTramioTtsOptionPitch;           // optional, NSNumber
extern NSString *const kTramioTtsOptionVolume;          // optional, NSNumber

@interface TramioTtsEngine : RCTEventEmitter <RCTBridgeModule>
@end

NS_ASSUME_NONNULL_END
