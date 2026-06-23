# Tramio Audio_Service — iOS

Native iOS side of the Audio_Service turbo module (task 8.3 in
`.kiro/specs/urban-narrative-mvp/tasks.md`).

## Files

- `TramioAudioService.h` / `.m` — RCTBridgeModule + RCTEventEmitter
  implementation. Mirrors the TypeScript spec in
  `packages/native/src/audio/NativeAudioService.ts` one-for-one.

## What it does

- Configures `AVAudioSession` with the `.playback` category and
  `mixWithOthers: false` so iOS treats Tramio as the foreground audio
  app and grants the background audio mode declared in `app.config.ts`
  (Req 12.1).
- Plays a single `AVAudioPlayer`-backed segment at a time (Req 1.3).
- Captures the playback offset on `AVAudioSession.interruptionNotification`
  (`InterruptionTypeBegan`) and emits `onFocusLoss` with the captured
  offset (Req 10.1). Emits `onFocusRegain` on `InterruptionTypeEnded`;
  the JS engine drives the actual `resume(offsetMs)` call so the 10-min
  discard rule (Req 10.3) and entitlement gating run through the
  reducer.
- Applies a per-segment `gainOffsetDb` as a linear scalar on
  `AVAudioPlayer.volume` to approximate the ~ -16 LUFS target. Real
  loudness measurement is out of MVP scope; the catalog is responsible
  for staying inside the ±3 dB tolerance band (Req 9.3).
- Ducking via `AVAudioPlayer.volume`. A `duck(percent)` >= 50 satisfies
  Req 10.4.

## Wiring (deferred)

These are listed here so reviewers don't mistake them for missing
features:

- **Encrypted-stream playback.** The TS spec carries a
  `DecryptStreamHandle` source kind so the engine can ask
  `Crypto_Service` to open a streaming decrypt session and feed the
  player without exposing plaintext to JS (design.md "Audio_Service >
  Plaintext-free playback path", Req 21.6/21.7). The native resolver
  for that handle lands with task 13.1 wiring; until then, a `stream`
  source emits a synthetic `onPlaybackFinished{reason: "error"}` so
  the engine can advance.
- **Pod / podspec registration.** The Expo prebuild flow regenerates
  `ios/`; this directory is only the source of truth that prebuild and
  the eventual Expo config plugin point at. The plugin is added when
  task 13.1 wires the JS-side translator end-to-end.
- **Codegen.** The TS spec at `packages/native/src/audio/NativeAudioService.ts`
  is shaped to be promoted to a turbo-module codegen spec without
  rename. We're still on the legacy `RCTBridgeModule` bridge for
  registration; codegen migration is a follow-up.

## Android

Android side is task 8.4. Both implementations bind to the same TS
spec so the engine command translator (task 13.1) is platform-agnostic.
