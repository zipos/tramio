// AudioPlaybackPort — injectable adapter for pre-rendered audio playback.
//
// The port abstracts the native audio player so:
//   1. TourRuntime tests can inject a fake without needing native modules.
//   2. Production wiring plugs in the expo-audio SDK 57 adapter.
//
// The port plays one local file at a time and reports lifecycle events.
// It does NOT manage the audio session — that remains the caller's concern
// (see audioSession.ts).

/**
 * Lifecycle events reported by the audio playback port.
 */
export interface AudioPlaybackCallbacks {
  /** Playback started (file loaded and playing). */
  onStart?: () => void;
  /** Natural end-of-file reached. */
  onComplete?: () => void;
  /** Playback failed with an error. */
  onError?: (message: string) => void;
}

/**
 * Status snapshot returned by the port.
 */
export interface AudioPlaybackStatus {
  /** Whether the player is currently playing audio. */
  readonly playing: boolean;
  /** Current playback position in seconds. */
  readonly positionSec: number;
  /** Total duration of the loaded file in seconds (0 if not loaded). */
  readonly durationSec: number;
}

/**
 * Minimal contract for playing a local audio file.
 *
 * Implementations MUST:
 * - Call onComplete exactly once when the file reaches its natural end.
 * - Call onError if playback fails (file missing, decode error, etc.).
 * - Never call callbacks after `release()` has been called.
 * - Support pause()/resume() — resume from paused offset.
 * - Support stop() — halts playback, does NOT release the player.
 * - Support release() — frees native resources; no further calls valid.
 */
export interface AudioPlaybackPort {
  /**
   * Load and start playing a local file.
   * @param fileUri Absolute file URI (e.g. `file:///.../*.m4a`).
   * @param callbacks Lifecycle callbacks for this playback session.
   */
  play(fileUri: string, callbacks: AudioPlaybackCallbacks): void;

  /** Pause playback at current offset. */
  pause(): void;

  /** Resume playback from paused offset. */
  resume(): void;

  /** Stop playback (resets position). Does not release resources. */
  stop(): void;

  /** Get current playback status. */
  getStatus(): AudioPlaybackStatus;

  /** Release native resources. No further calls are valid after this. */
  release(): void;
}
