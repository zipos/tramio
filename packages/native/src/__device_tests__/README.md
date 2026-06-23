# Instrumented Device Smoke Tests

These tests verify native-side behavior that cannot be validated in a
headless Jest environment. They require a real iOS or Android device (or
simulator/emulator with location simulation support).

## What they cover

| Module           | iOS                                      | Android                                      |
| ---------------- | ---------------------------------------- | -------------------------------------------- |
| Location_Service | Region monitoring, geofence wake, events | FusedLocation + GeofencingClient, foreground service |
| Audio_Service    | AVAudioPlayer background audio, focus    | ExoPlayer background audio, AudioFocus       |
| TTS_Engine       | AVSpeechSynthesizer speak/stop, fallback | android.speech.tts.TextToSpeech, fallback    |

## Running

These tests are designed to run via Detox (if configured) or as manual
integration test stubs executed on-device. They are NOT part of the
standard `jest --ci` pipeline.

```bash
# If Detox is configured:
npx detox test --configuration ios.sim.debug --testPathPattern __device_tests__

# Otherwise, build the app in debug mode and run manually:
npx react-native run-ios
# Then trigger the test harness from the dev menu.
```

## Requirements validated

- Req 1.7: Tour-end resource release within 2 seconds
- Req 9.3: Volume normalization (~-16 LUFS ±3 dB)
- Req 10.1: Focus-loss pause with offset capture within 500 ms
- Req 12.1: Background audio playback maintained
- Req 12.2: Geofence events delivered in background
- Req 12.3: OS-delivered geofence wake events resume the engine
