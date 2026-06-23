// TramioAudioService.h
//
// iOS native side of the Audio_Service turbo module (task 8.3).
// Pairs with packages/native/src/audio/NativeAudioService.ts.
//
// Responsibilities:
//   * Sequential playback of a single AVAudioPlayer-backed segment.
//   * AVAudioSession set to AVAudioSessionCategoryPlayback with the
//     mix-with-others option DISABLED (mixWithOthers: false), so the
//     OS treats Tramio as the foreground audio app and grants the
//     background-audio mode declared in app.config.ts.
//   * AVAudioSession.interruptionNotification -> JS focus loss/regain
//     events. The JS-side engine records the captured offset and
//     drives `resume(offsetMs)`.
//   * LUFS normalization knob: a `gainOffsetDb` value supplied per
//     segment is converted to a linear scalar and multiplied into
//     `AVAudioPlayer.volume`. Real loudness measurement is out of
//     MVP scope; the catalog is responsible for staying inside the
//     ~ -16 LUFS ±3 dB tolerance band described in design.md and
//     Requirement 9.3.
//   * Ducking via `AVAudioPlayer.volume`. A `duck(percent)` of >= 50
//     satisfies Requirement 10.4 ("at least 50%").
//
// The Android side is task 8.4. Codegen integration arrives with task
// 13.1 wiring; until then this module registers via RCTBridgeModule
// and emits events with RCTEventEmitter.

#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

NS_ASSUME_NONNULL_BEGIN

/// Module name as exposed to JavaScript via `NativeModules.TramioAudioService`.
/// The TS turbo-module spec (`NativeAudioService.ts`) is shaped to match.
extern NSString *const kTramioAudioServiceModuleName;

/// Event names emitted to JS (mirrors AudioServiceEvent in
/// packages/native/src/audio/types.ts).
extern NSString *const kTramioAudioEventPlaybackFinished;
extern NSString *const kTramioAudioEventFocusLoss;
extern NSString *const kTramioAudioEventFocusRegain;
extern NSString *const kTramioAudioEventDuckingChange;

@interface TramioAudioService : RCTEventEmitter <RCTBridgeModule>

@end

NS_ASSUME_NONNULL_END
