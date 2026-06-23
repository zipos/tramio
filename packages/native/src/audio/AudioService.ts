// AudioService — typed wrapper around the Audio_Service turbo module.
//
// Layered on top of the raw `Spec` (NativeAudioService.ts) so consumers
// never have to think about JSON-serialized arguments, listener tokens,
// or clamping invariants. The engine command translator (task 13.1)
// imports `AudioService` and passes through `EngineCommand`s; this
// surface is shaped so wiring 13.1 will not change anything declared
// here.
//
// Plaintext-free playback path (design.md "Audio_Service > Plaintext-
// free playback path"): protected segments are played from a
// `DecryptStreamHandle` opened by Crypto_Service. The wrapper exposes
// `playStream(...)` for that path; `playUrl(...)` is reserved for
// unprotected standby tracks and development bring-up.
//
// @see Requirements 9.3, 10.1, 10.2, 10.3, 10.4, 12.1, 15.1

import {
  DEFAULT_PLAY_OPTIONS,
  DUCK_ACTIVE_THRESHOLD_PERCENT,
  DUCK_PERCENT_MAX,
  DUCK_PERCENT_MIN,
  GAIN_OFFSET_DB_MAX,
  GAIN_OFFSET_DB_MIN,
  type Spec,
} from './NativeAudioService';
import type {
  AudioServiceEvent,
  AudioServiceEventKind,
  AudioServiceListener,
  AudioSource,
  DecryptStreamHandle,
  PlayOptions,
  Unsubscribe,
} from './types';

/** Clamp a number into `[lo, hi]`. */
function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** Apply the documented clamps to caller-supplied {@link PlayOptions}. */
function normalizeOptions(opts: PlayOptions | undefined): Required<PlayOptions> {
  const merged = { ...DEFAULT_PLAY_OPTIONS, ...(opts ?? {}) };
  return {
    startOffsetMs: Math.max(0, merged.startOffsetMs),
    gainOffsetDb: clamp(merged.gainOffsetDb, GAIN_OFFSET_DB_MIN, GAIN_OFFSET_DB_MAX),
    initialDuckPercent: clamp(merged.initialDuckPercent, DUCK_PERCENT_MIN, DUCK_PERCENT_MAX),
  };
}

/**
 * Public Audio_Service API consumed by the engine command translator.
 *
 * The class is a thin orchestration layer over `Spec`; we keep it as a
 * class (rather than a free function set) so the engine wiring task
 * (13.1) can dependency-inject a different `Spec` for tests without
 * touching call sites.
 */
export class AudioService {
  private readonly spec: Spec;
  private readonly listenerTokens = new Set<string>();

  constructor(spec: Spec) {
    this.spec = spec;
  }

  /**
   * Play a protected segment via a streaming-decrypt handle.
   *
   * The handle MUST come from `Crypto_Service.openDecryptedStream(...)`
   * (design.md). The wrapper does no validation beyond serializing it
   * across the bridge; the native side resolves it to plaintext bytes
   * without ever exposing them to JS (Req 21.6, 21.7).
   */
  async playStream(
    segmentId: string,
    handle: DecryptStreamHandle,
    opts?: PlayOptions,
  ): Promise<void> {
    const source: AudioSource = { kind: 'stream', handle };
    return this.dispatchPlay(segmentId, source, opts);
  }

  /**
   * Play an unprotected segment from a URL (file:// or https://).
   *
   * Reserved for unprotected standby tracks (design.md "Offline_Pack
   * layout" leaves `tiles/` and `standby/{trackId}.json` plaintext) and
   * for development bring-up. Production tour audio MUST use
   * {@link playStream} so plaintext bytes never leave the native module.
   */
  async playUrl(segmentId: string, url: string, opts?: PlayOptions): Promise<void> {
    const source: AudioSource = { kind: 'url', url };
    return this.dispatchPlay(segmentId, source, opts);
  }

  /**
   * Pause the current segment and resolve with the captured offset
   * (ms). The engine records this offset and passes it back through
   * `resume(...)` (Req 10.1, 10.2).
   */
  pause(): Promise<number> {
    return this.spec.pause();
  }

  /**
   * Resume from `offsetMs`. Idempotent if no segment is paused.
   *
   * `offsetMs` is clamped to a non-negative integer because RN's bridge
   * has historically rounded floats inconsistently across platforms.
   */
  resume(offsetMs: number): Promise<void> {
    const clean = Math.max(0, Math.floor(offsetMs));
    return this.spec.resume(clean);
  }

  /** Stop and release the active segment. Idempotent. */
  stop(): Promise<void> {
    return this.spec.stop();
  }

  /**
   * Set the ducking level as a percentage in `[0, 100]`.
   *
   * Per Req 10.4 a transient ducking event MUST reduce volume by at
   * least 50%, so callers driving navigation-prompt ducking SHOULD pass
   * `>= 50`. {@link isDuckActive} reports whether a given value crosses
   * the threshold without forcing the caller to remember the constant.
   */
  duck(percent: number): Promise<void> {
    const clean = clamp(percent, DUCK_PERCENT_MIN, DUCK_PERCENT_MAX);
    return this.spec.duck(clean);
  }

  /** Whether `percent` qualifies as an active duck per Req 10.4. */
  static isDuckActive(percent: number): boolean {
    return percent >= DUCK_ACTIVE_THRESHOLD_PERCENT;
  }

  /**
   * Subscribe to a single normalized event kind. Returns an
   * `Unsubscribe` so callers don't need to track tokens themselves.
   */
  on<K extends AudioServiceEventKind>(kind: K, listener: AudioServiceListener<K>): Unsubscribe {
    // Bridge the generic kind to its concrete payload via a single
    // `unknown` widening at the call site. TS can't narrow a generic
    // `K` to a specific union member, so we keep the cast small,
    // local, and centralized rather than duplicating it per branch.
    const dispatch = listener as (ev: AudioServiceEvent) => void;
    let token: string;
    switch (kind) {
      case 'PlaybackFinished':
        token = this.spec.addPlaybackFinishedListener((ev) =>
          dispatch({ kind: 'PlaybackFinished', ...ev }),
        );
        break;
      case 'FocusLoss':
        token = this.spec.addFocusLossListener((ev) => dispatch({ kind: 'FocusLoss', ...ev }));
        break;
      case 'FocusRegain':
        token = this.spec.addFocusRegainListener((ev) => dispatch({ kind: 'FocusRegain', ...ev }));
        break;
      case 'DuckingChange':
        token = this.spec.addDuckingChangeListener((ev) =>
          dispatch({ kind: 'DuckingChange', ...ev }),
        );
        break;
      default: {
        // Exhaustiveness check: if a new event kind is added to
        // `AudioServiceEventKind` and forgotten here, this line fails
        // to compile.
        const _exhaustive: never = kind;
        throw new Error(`AudioService.on: unknown event kind ${String(_exhaustive)}`);
      }
    }
    this.listenerTokens.add(token);
    return () => this.detach(token);
  }

  /**
   * Subscribe to every event kind through a single callback. Convenient
   * for tests; the engine translator uses `on(kind, ...)` per kind.
   */
  onAny(listener: (ev: AudioServiceEvent) => void): Unsubscribe {
    const subs: Unsubscribe[] = [
      this.on('PlaybackFinished', listener),
      this.on('FocusLoss', listener),
      this.on('FocusRegain', listener),
      this.on('DuckingChange', listener),
    ];
    return () => {
      for (const u of subs) u();
    };
  }

  /** Detach all listeners this wrapper has registered. */
  removeAllListeners(): void {
    for (const token of this.listenerTokens) {
      this.spec.removeListener(token);
    }
    this.listenerTokens.clear();
  }

  // -- Internals -----------------------------------------------------

  private dispatchPlay(segmentId: string, source: AudioSource, opts?: PlayOptions): Promise<void> {
    if (segmentId.length === 0) {
      return Promise.reject(new Error('AudioService.play: segmentId must be non-empty'));
    }
    const normalized = normalizeOptions(opts);
    return this.spec.play(segmentId, JSON.stringify(source), JSON.stringify(normalized));
  }

  private detach(token: string): void {
    if (this.listenerTokens.delete(token)) {
      this.spec.removeListener(token);
    }
  }
}
