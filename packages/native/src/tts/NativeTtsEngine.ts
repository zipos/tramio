// @tramio/native — TTS_Engine turbo module spec
//
// JS-side spec for the TTS_Engine turbo module (Req 15.1). Wraps the
// native iOS `TramioTtsEngine` (AVSpeechSynthesizer) and the upcoming
// Android `TramioTtsEngine` (android.speech.tts.TextToSpeech) behind a
// uniform TS surface. Events are shaped identically to Audio_Service
// (`onPlaybackFinished`, `onFocusLoss`, `onFocusRegain`) so the engine's
// command translator (task 13.1) can wire either backend without
// branching, satisfying Property 9's audio source selection.
//
// This file deliberately defers OS-specific concerns (voice catalog,
// LUFS normalization, ducking) to the native sides. The TS layer only
// owns:
//
//   - The method surface (`speak`, `pause`, `resume`, `stop`).
//   - The unified event listener registry.
//   - A fake binding for unit tests (so the engine reducer can be
//     exercised end-to-end in Node without the native runtime).
//
// Spec references: Req 9.2, 9.4, 15.1.

import type {
  FocusLossListener,
  FocusRegainListener,
  NativeTtsEngineBinding,
  PlaybackFinishedListener,
  SpeakOptions,
  TtsPlaybackEvent,
  TtsPlaybackListener,
  Unsubscribe,
} from './types';

/**
 * Public TS surface used by the engine's command translator.
 *
 * The interface intentionally matches Audio_Service's vocabulary — see
 * design.md "Components and Interfaces > Audio_Service":
 * _Sequential playback of one segment at a time. [...] Audio focus loss /
 * regain handling with offset capture._
 *
 * The TTS engine does not record offsets (re-synthesizing from the
 * Markdown source from scratch on resume is acceptable for the MVP), but
 * the event names match so wiring is uniform.
 */
export interface NativeTtsEngine {
  speak(text: string, opts: SpeakOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Subscribe to the playback-finished event. The native side fires this
   * when `AVSpeechSynthesizerDelegate.speechSynthesizer:didFinishSpeechUtterance:`
   * (iOS) or the equivalent Android `UtteranceProgressListener.onDone`
   * callback runs.
   */
  onPlaybackFinished(listener: PlaybackFinishedListener): Unsubscribe;

  /**
   * Subscribe to audio focus loss. iOS: `AVAudioSession`
   * `AVAudioSessionInterruptionNotification` (`began`). Android:
   * `AudioManager.AUDIOFOCUS_LOSS_TRANSIENT` from the focus request.
   *
   * Shape matches Audio_Service so task 13.1 can route both sources
   * through one reducer event (`FocusLoss` from design.md).
   */
  onFocusLoss(listener: FocusLossListener): Unsubscribe;

  /**
   * Subscribe to audio focus regain. iOS: `AVAudioSession`
   * `AVAudioSessionInterruptionNotification` (`ended`, with
   * `shouldResume`). Android: `AUDIOFOCUS_GAIN`.
   */
  onFocusRegain(listener: FocusRegainListener): Unsubscribe;

  /**
   * Detach the underlying native binding subscription. Called by the
   * engine's `ReleaseAll` command path (design.md). Idempotent.
   */
  release(): void;
}

/**
 * Build the JS wrapper around a native binding.
 *
 * The native module is intentionally thin: this function is the only
 * place the multiplexed `addPlaybackListener` is unpacked into the
 * three Audio_Service-shaped subscriptions exposed to the engine.
 */
export function createNativeTtsEngine(binding: NativeTtsEngineBinding): NativeTtsEngine {
  const playbackFinishedListeners = new Set<PlaybackFinishedListener>();
  const focusLossListeners = new Set<FocusLossListener>();
  const focusRegainListeners = new Set<FocusRegainListener>();

  const dispatch: TtsPlaybackListener = (event: TtsPlaybackEvent): void => {
    switch (event.kind) {
      case 'PlaybackFinished': {
        const payload = { segmentId: event.segmentId } as const;
        for (const l of playbackFinishedListeners) {
          // Listeners run synchronously; native side already serializes
          // delivery on the JS thread.
          l(payload);
        }
        return;
      }
      case 'FocusLoss': {
        for (const l of focusLossListeners) l();
        return;
      }
      case 'FocusRegain': {
        for (const l of focusRegainListeners) l();
        return;
      }
    }
  };

  // Single subscription against the binding; per-event dispatch is owned
  // by the wrapper. This avoids leaking N native subscriptions for N JS
  // listeners and keeps the bridge cost flat.
  let detach: Unsubscribe | null = binding.addPlaybackListener(dispatch);

  return {
    speak(text: string, opts: SpeakOptions): Promise<void> {
      return binding.speak(text, opts);
    },
    pause(): Promise<void> {
      return binding.pause();
    },
    resume(): Promise<void> {
      return binding.resume();
    },
    stop(): Promise<void> {
      return binding.stop();
    },
    onPlaybackFinished(listener: PlaybackFinishedListener): Unsubscribe {
      playbackFinishedListeners.add(listener);
      return () => {
        playbackFinishedListeners.delete(listener);
      };
    },
    onFocusLoss(listener: FocusLossListener): Unsubscribe {
      focusLossListeners.add(listener);
      return () => {
        focusLossListeners.delete(listener);
      };
    },
    onFocusRegain(listener: FocusRegainListener): Unsubscribe {
      focusRegainListeners.add(listener);
      return () => {
        focusRegainListeners.delete(listener);
      };
    },
    release(): void {
      if (detach !== null) {
        detach();
        detach = null;
      }
      playbackFinishedListeners.clear();
      focusLossListeners.clear();
      focusRegainListeners.clear();
    },
  };
}

export type { NativeTtsEngineBinding } from './types';
