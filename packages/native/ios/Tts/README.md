# TramioTtsEngine (iOS)

iOS native side of the `TTS_Engine` turbo module declared in
`packages/native/src/tts/NativeTtsEngine.ts`. Wraps `AVSpeechSynthesizer`
(Req 15.1) and exposes the JS-side spec's `speak` / `pause` / `resume` /
`stop` methods plus the unified playback event stream.

## Files

- `TramioTtsEngine.h` — public Obj-C header, `RCTBridgeModule` +
  `RCTEventEmitter` interface and event-name constants.
- `TramioTtsEngine.m` — implementation. Covers voice resolution, the
  `AVSpeechSynthesizerDelegate` callbacks, and the audio-focus
  piggyback on `AVAudioSessionInterruptionNotification`.

## Voice resolution

Resolves `(language, region)` against `AVSpeechSynthesisVoice.speechVoices`
following the documented fallback chain in
`packages/native/src/tts/resolveVoice.ts`:

1. Exact `(language, region)` match.
2. Exact `language` match.
3. Platform default voice for that language
   (`AVSpeechSynthesisVoice.voiceWithLanguage:`).
4. Platform default voice for the bundle's `defaultLanguage`.

Each fallback step that misses logs a non-fatal warning via `os_log`
(`OS_LOG_TYPE_INFO`) so the failure is visible in Console.app without
being treated as a runtime error (Req 9.4).

## Event shapes

Mirrors `Audio_Service` (design.md) so the engine's command translator
can wire either backend without branching:

- `onPlaybackFinished` — `{ segmentId: string }`. Emitted from both
  `speechSynthesizer:didFinishSpeechUtterance:` and
  `speechSynthesizer:didCancelSpeechUtterance:` so the engine sees a
  finish event for natural completion and for `stop`.
- `onFocusLoss` — `{}`. Triggered by `AVAudioSessionInterruptionNotification`
  with type `Began`.
- `onFocusRegain` — `{}`. Triggered by the same notification with type
  `Ended`.

`AVAudioSession` category management is owned by `Audio_Service`; this
module observes the interruption notification but does not configure
the session itself.

## Wiring

Autolinked once the consuming Expo bare project's iOS target imports
this directory via a podspec or `node_modules/@tramio/native/ios/` link
(set up in task 13.1). Until then the files compile as-is in any
React Native iOS target that references them.

## Related

- TS spec: `packages/native/src/tts/NativeTtsEngine.ts`
- Voice resolver: `packages/native/src/tts/resolveVoice.ts`
- Android side: task 8.6 (`packages/native/android/Tts/...`)
