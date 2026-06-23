# Tramio Audio_Service — Android

Native Android side of the Audio_Service turbo module (task 8.4 in
`.kiro/specs/urban-narrative-mvp/tasks.md`).

## Files

- `TramioAudioServiceModule.kt` — `ReactContextBaseJavaModule`
  implementation. Mirrors the TypeScript spec in
  `packages/native/src/audio/NativeAudioService.ts` one-for-one and
  emits the same event names as the iOS module
  (`onPlaybackFinished`, `onFocusLoss`, `onFocusRegain`,
  `onDuckingChange`).
- `TramioAudioServicePackage.kt` — `ReactPackage` registering the module
  with the host app's `MainApplication`.

## Gradle dependency

The module depends on `androidx.media3:media3-exoplayer` (and the
`media3-common` transitive). Expo bare projects own the gradle file
that consumes this directory; the relevant additions to the consuming
app's `android/app/build.gradle` look like:

```gradle
dependencies {
    // …existing deps…
    implementation "androidx.media3:media3-exoplayer:1.4.1"
    implementation "androidx.media3:media3-common:1.4.1"
}
```

We pin to a specific minor; bumping is a separate task. media3 1.4.x
requires `compileSdkVersion >= 34`; the Expo build properties in
`app.config.ts` already pin `compileSdkVersion = 35`.

The module sources themselves are wired into the prebuilt
`android/app/src/main/java/...` tree via the same Expo autolinking flow
as the iOS pod (task 13.1 wiring). For the MVP we host them under this
directory as the source of truth and the Expo config plugin / prebuild
copies them into the generated project.

## What it does

- Plays a single segment at a time using ExoPlayer (Req 1.3). On
  `play(...)` any in-flight player is released before the new one is
  built, preserving the `|playing| <= 1` invariant.
- Configures ExoPlayer's `AudioAttributes` with
  `USAGE_ASSISTANCE_NAVIGATION_GUIDANCE` + `CONTENT_TYPE_SPEECH` so
  Android's audio policy treats the stream as guidance audio (paired
  with the foreground service from task 8.2 this keeps the tour audible
  in the background, Req 12.1).
- Requests audio focus through `AudioFocusRequest` (API 26+) using
  `AUDIOFOCUS_GAIN`. The OS hands us focus-change callbacks that we
  translate into JS-side `onFocusLoss` / `onFocusRegain` /
  `onDuckingChange` events:
  - `AUDIOFOCUS_LOSS` and `AUDIOFOCUS_LOSS_TRANSIENT`: pause the player,
    capture the playback offset (ms), and emit `onFocusLoss` with the
    offset (Req 10.1). The JS engine records the offset and drives the
    eventual `resume(offsetMs)` call so the 10-minute discard rule
    (Req 10.3) and entitlement gating run through the reducer.
  - `AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK`: lower volume by ≥50%
    (Req 10.4) and emit `onDuckingChange { percent: 50 }`. We don't
    pause; the OS expects the app to keep playing at a reduced level.
  - `AUDIOFOCUS_GAIN`: restore volume to the per-segment normalized
    level and emit `onFocusRegain`. The actual `play()` call comes from
    the JS engine.
- LUFS normalization: a per-segment `gainOffsetDb` (clamped to ±12 dB
  by the JS wrapper, with native re-clamping for defense in depth) is
  converted to a linear scalar (`10 ** (dB / 20)`) and applied to the
  player's `volume`. Real loudness measurement is out of MVP scope; the
  catalog is responsible for keeping assets inside the ~ -16 LUFS
  ±3 dB band (Req 9.3).
- Ducking through `volume`: a `duck(percent)` of >= 50 satisfies
  Req 10.4. The duck attenuator multiplies into the gain scalar so the
  two knobs compose without one cancelling the other.
- Foreground service coordination: on `play(...)` we post a sticky
  notification through the foreground service from task 8.2 so the OS
  keeps the process alive in the background (Req 12.1). On `stop(...)`
  we abandon audio focus and let the engine drop the notification when
  it tears down its own location side. The notification text is owned
  by the foreground service component; this module only signals
  start/stop intent.

## What it intentionally does NOT do (MVP scope)

- **Real LUFS measurement.** Loudness target is approximated via the
  per-asset `gainOffsetDb`. Same caveat as iOS.
- **Encrypted-stream playback (`DecryptStreamHandle`).** The TS surface
  exposes a `stream` source kind; the Android resolver for that handle
  lands with task 13.1 wiring. Until then a `stream` source emits a
  synthetic `onPlaybackFinished{reason: "error"}` so the engine can
  advance instead of waiting forever.
- **media3 codegen migration.** We register through
  `ReactContextBaseJavaModule` for parity with the iOS
  `RCTBridgeModule`. The TS spec
  (`packages/native/src/audio/NativeAudioService.ts`) is shaped to be
  promoted to a turbo-module codegen spec without rename.

## iOS

iOS side is task 8.3 (already shipped). Both implementations bind to
the same TS spec so the engine command translator (task 13.1) is
platform-agnostic.
