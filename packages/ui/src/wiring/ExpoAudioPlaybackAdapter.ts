// ExpoAudioPlaybackAdapter — production AudioPlaybackPort using expo-audio SDK 57.
//
// Uses `createAudioPlayer(source)` from expo-audio. The AudioPlayer instance
// is a SharedObject<AudioEvents> with `play()`, `pause()`, `remove()` methods
// and a typed `addListener('playbackStatusUpdate', handler)` event interface.
//
// ## Lifecycle
//
// - play(path) creates a fresh player for each file, replacing any prior one.
//   A monotonically increasing generation token guards against stale async
//   loads: if play(B) is called before play(A)'s import/load resolves, A's
//   resolution discovers a token mismatch and abandons without side-effects.
// - stop() disposes the current native player and suppresses all pending
//   callbacks. Because each play() creates a new player, stop() is equivalent
//   to destroying the native resource.
// - release() is a terminal operation: marks the adapter as released,
//   disposes any active player, and suppresses all future callbacks.
//
// ## Path contract
//
// `play(path)` accepts either a bare absolute local path (e.g.
// `/data/.../audio.m4a`) or a `file://` URI. The value is passed directly to
// `createAudioPlayer({ uri })` which handles both forms on iOS and Android.
//
// ## Callback semantics
//
// - onStart fires exactly once per play() call, on the first status where
//   `isLoaded && playing` is true.
// - onComplete fires exactly once on `didJustFinish`.
// - onError fires exactly once on `status.error`.
// - After any terminal event (complete or error), the listener subscription
//   and player are released. Callbacks are never invoked after stop() or
//   release().

import type {
  AudioPlaybackCallbacks,
  AudioPlaybackPort,
  AudioPlaybackStatus,
} from './AudioPlaybackPort';

// ─── Minimal inline types for the expo-audio subset we use ───────────────
// We avoid top-level `import type` from 'expo-audio' because expo-audio
// depends on 'expo-modules-core' which may not resolve at the root tsconfig
// level (it's nested under expo/node_modules/). Using inline minimal types
// keeps the adapter compilable without polluting the resolution graph.

/** Subset of expo-audio AudioStatus we consume in the status handler. */
interface ExpoAudioStatus {
  readonly playing: boolean;
  readonly isLoaded: boolean;
  readonly didJustFinish: boolean;
  readonly error: string | null;
  readonly currentTime: number;
  readonly duration: number;
}

/** Subset of expo-audio AudioPlayer we use at runtime. */
interface ExpoAudioPlayer {
  readonly playing: boolean;
  readonly currentTime: number;
  readonly duration: number;
  play(): void;
  pause(): void;
  remove(): void;
  addListener(
    event: 'playbackStatusUpdate',
    handler: (status: ExpoAudioStatus) => void,
  ): { remove(): void };
}

/**
 * Factory function type for creating an AudioPlayer. Extracted so tests can
 * inject a fake without importing the native expo-audio module.
 */
export type CreateAudioPlayerFn = (source: { uri: string }) => ExpoAudioPlayer;

/** Lazy-loaded createAudioPlayer from expo-audio. */
let _cachedCreatePlayer: CreateAudioPlayerFn | undefined;

async function loadCreateAudioPlayer(): Promise<CreateAudioPlayerFn> {
  if (_cachedCreatePlayer) return _cachedCreatePlayer;
  const mod = await import('expo-audio');
  _cachedCreatePlayer = mod.createAudioPlayer as unknown as CreateAudioPlayerFn;
  return _cachedCreatePlayer;
}

export class ExpoAudioPlaybackAdapter implements AudioPlaybackPort {
  /**
   * Monotonically increasing generation counter. Each play() call increments
   * this. Async callbacks compare the captured generation against the current
   * one; a mismatch means a newer play/stop/release has superseded them.
   */
  private generation = 0;
  private player: ExpoAudioPlayer | null = null;
  private subscription: { remove(): void } | null = null;
  private callbacks: AudioPlaybackCallbacks = {};
  private released = false;
  private startFired = false;
  private terminalFired = false;

  /** Optional injected factory for testing without native modules. */
  private readonly createPlayerFn: CreateAudioPlayerFn | null;

  constructor(createPlayerFn?: CreateAudioPlayerFn) {
    this.createPlayerFn = createPlayerFn ?? null;
  }

  play(path: string, callbacks: AudioPlaybackCallbacks): void {
    if (this.released) return;

    // Invalidate any prior pending load or active player.
    this.disposeCurrentPlayer();

    this.generation++;
    const gen = this.generation;
    this.callbacks = callbacks;
    this.startFired = false;
    this.terminalFired = false;

    void this.loadAndPlay(path, gen);
  }

  private async loadAndPlay(path: string, gen: number): Promise<void> {
    try {
      const createPlayer = this.createPlayerFn ?? (await loadCreateAudioPlayer());

      // Stale check: if generation advanced or released, abandon.
      if (this.released || this.generation !== gen) return;

      const player = createPlayer({ uri: path });

      // Second stale check after synchronous player creation.
      if (this.released || this.generation !== gen) {
        try {
          player.remove();
        } catch {
          /* already disposed */
        }
        return;
      }

      this.player = player;

      // Subscribe to status updates via the typed EventEmitter interface.
      this.subscription = player.addListener('playbackStatusUpdate', (status: ExpoAudioStatus) => {
        this.handleStatus(status, gen, player);
      });

      player.play();
    } catch (err: unknown) {
      if (this.released || this.generation !== gen) return;
      this.fireTerminal('error', err instanceof Error ? err.message : String(err), gen);
    }
  }

  private handleStatus(status: ExpoAudioStatus, gen: number, player: ExpoAudioPlayer): void {
    // Stale guard: generation advanced, stop/release happened, or terminal already fired.
    if (this.released || this.generation !== gen || this.player !== player) return;

    if (status.error) {
      this.fireTerminal('error', status.error, gen);
      return;
    }

    if (status.didJustFinish) {
      this.fireTerminal('complete', undefined, gen);
      return;
    }

    // Fire onStart exactly once when loaded and playing.
    if (status.isLoaded && status.playing && !this.startFired && !this.terminalFired) {
      this.startFired = true;
      this.callbacks.onStart?.();
    }
  }

  private fireTerminal(kind: 'complete' | 'error', msg: string | undefined, gen: number): void {
    if (this.terminalFired || this.released || this.generation !== gen) return;
    this.terminalFired = true;

    // Capture callbacks before cleanup (cleanup clears them via disposeCurrentPlayer).
    const cbs = this.callbacks;

    // Release player and subscription for this terminal event.
    this.releaseSubscription();
    this.releasePlayer();

    // Fire callback. The adapter remains usable for subsequent play() calls.
    if (kind === 'complete') {
      cbs.onComplete?.();
    } else {
      cbs.onError?.(msg ?? 'Unknown error');
    }
  }

  pause(): void {
    if (this.released || !this.player) return;
    this.player.pause();
  }

  resume(): void {
    if (this.released || !this.player) return;
    this.player.play();
  }

  /**
   * Stop playback and dispose the native player resource.
   *
   * Because each play() creates a fresh player, stop() is equivalent to
   * destroying the native resource. No callbacks are fired after stop().
   */
  stop(): void {
    if (this.released) return;
    this.disposeCurrentPlayer();
  }

  getStatus(): AudioPlaybackStatus {
    if (!this.player || this.released) {
      return { playing: false, positionSec: 0, durationSec: 0 };
    }
    return {
      playing: this.player.playing,
      positionSec: this.player.currentTime,
      durationSec: this.player.duration,
    };
  }

  /**
   * Release the adapter. No further calls are valid after this.
   * Disposes any active player and suppresses all callbacks.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.disposeCurrentPlayer();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────

  private disposeCurrentPlayer(): void {
    // Increment generation to invalidate any pending async loads.
    this.generation++;
    this.releaseSubscription();
    this.releasePlayer();
    this.callbacks = {};
    this.startFired = false;
    this.terminalFired = false;
  }

  private releaseSubscription(): void {
    if (this.subscription) {
      this.subscription.remove();
      this.subscription = null;
    }
  }

  private releasePlayer(): void {
    if (this.player) {
      try {
        this.player.remove();
      } catch {
        /* Player may already be disposed. */
      }
      this.player = null;
    }
  }
}
