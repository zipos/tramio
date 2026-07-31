// audioSession — configures the iOS/Android audio session for background TTS.
//
// iOS requires an AVAudioSession with category `.playback` to keep audio
// alive when the screen locks and to honour the silent switch. expo-speech
// inherits the default `soloAmbient` category, which is interrupted on
// lock and muted by the hardware switch. By configuring expo-audio's
// session to `.playback` + background + silent-mode override, ALL audio
// on the device (including expo-speech TTS) inherits that session
// configuration.
//
// We never actually play audio through expo-audio; we only use it to
// configure the underlying native audio session. This is the lightest
// possible integration that solves the background-audio bug without
// replacing expo-speech or importing packages/native/.
//
// @see app.config.ts UIBackgroundModes: ['audio']
// @see BUG 1 — iOS narration dies when screen locks

/**
 * Configure the audio session for tour narration playback:
 *   - playsInSilentMode: true  (honour the product, not the mute switch)
 *   - shouldPlayInBackground: true  (keep TTS alive on lock)
 *   - interruptionMode: 'duckOthers'  (don't kill a user's music permanently)
 *
 * Safe to call multiple times. Swallows errors so a missing native module
 * (e.g. in Jest or a broken prebuild) never crashes the tour.
 */
export async function configureTourAudioSession(): Promise<void> {
  try {
    const { setAudioModeAsync } = await import('expo-audio');
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'duckOthers',
    });
  } catch {
    // expo-audio native module may not be linked (dev builds, Jest).
    // The tour still works — just without background audio on iOS.
  }
}

/**
 * Release the audio session after the tour ends. Resets to defaults so
 * we don't hold the audio session category permanently.
 *
 * Safe to call multiple times. Swallows errors.
 */
export async function releaseTourAudioSession(): Promise<void> {
  try {
    const { setAudioModeAsync, setIsAudioActiveAsync } = await import('expo-audio');
    await setAudioModeAsync({
      playsInSilentMode: false,
      shouldPlayInBackground: false,
      interruptionMode: 'mixWithOthers',
    });
    await setIsAudioActiveAsync(false);
  } catch {
    // Swallow — same rationale as configureTourAudioSession.
  }
}
