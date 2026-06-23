// Audio_Service shared types.
//
// These types pin down the JS-side surface of the Audio_Service turbo
// module. They are deliberately framed in TS-only terms (no React Native
// imports) so they can be consumed by tests, by the engine command
// translator (task 13.1), and by the future RN turbo-module codegen
// without forcing a dependency on `react-native` in this package.
//
// @see design.md "Components and Interfaces > Audio_Service"
// @see Requirements 9.3, 10.1, 10.2, 10.3, 10.4, 12.1, 15.1

/**
 * Opaque handle to a streaming-decrypt session opened by Crypto_Service.
 *
 * The TypeScript layer never sees plaintext bytes. The handle is a
 * native-side reference that Audio_Service feeds directly into the
 * platform player as a chunked input stream
 * (`AVAssetResourceLoaderDelegate` on iOS, custom `DataSource` on
 * Android). Carrying it as a branded string keeps the contract honest:
 * JS code can store, forward, and compare handles, but cannot read or
 * synthesize one.
 *
 * @see design.md "Crypto_Service" and "Audio_Service > Plaintext-free
 *      playback path"
 * @see Requirements 21.6, 21.7
 */
export type DecryptStreamHandle = string & {
  readonly __brand: 'DecryptStreamHandle';
};

/**
 * Either a plaintext URL (e.g. `file://...m4a` for an unencrypted
 * standby asset, or `https://...` during development) or an opaque
 * decrypt-stream handle bound to a protected asset on disk.
 *
 * Production tour audio always travels via the handle path so that
 * decrypted bytes never leave the native module's address space
 * (Req 21.6, 21.7). The URL path exists for unprotected standby tracks
 * and for development bring-up.
 */
export type AudioSource =
  | { kind: 'url'; url: string }
  | { kind: 'stream'; handle: DecryptStreamHandle };

/**
 * Options accepted by `AudioService.play(...)`.
 *
 * `gainOffsetDb` is the LUFS-normalization knob described by the task
 * brief: real loudness measurement is out of MVP scope, so the catalog
 * publishes a per-asset offset in decibels and the native layer applies
 * it to the player's gain. The target is ~ -16 LUFS ±3 dB (Req 9.3);
 * offsets outside ±12 dB are clamped to keep accidental authoring
 * mistakes from blowing out the speaker.
 */
export interface PlayOptions {
  /**
   * Initial playback offset in milliseconds. Used when resuming after a
   * focus-loss interruption, or when a deeper layer is dispatched at a
   * non-zero start point.
   *
   * @default 0
   */
  readonly startOffsetMs?: number;

  /**
   * Gain offset in dB applied on top of the player's nominal volume to
   * approximate the ~ -16 LUFS target with ±3 dB tolerance (Req 9.3).
   * Values are clamped to ±12 dB.
   *
   * @default 0
   */
  readonly gainOffsetDb?: number;

  /**
   * Initial ducking level as a percentage [0, 100]. 0 means full
   * volume; values >= 50 satisfy the "lower output volume by at least
   * 50%" rule (Req 10.4).
   *
   * @default 0
   */
  readonly initialDuckPercent?: number;
}

/**
 * Reason carried alongside a `PlaybackFinished` event so the engine can
 * tell a clean end-of-segment from an error path.
 *
 * - `completed`: native player reached end of stream.
 * - `stopped`: caller invoked `stop()` or replaced the segment.
 * - `error`: native player or decrypt stream raised an error. The
 *   wrapper surfaces a synthetic `AudioFinished` to the engine so the
 *   reducer can advance (design.md "Audio_Service" > error handling).
 */
export type PlaybackFinishReason = 'completed' | 'stopped' | 'error';

export interface PlaybackFinishedEvent {
  readonly segmentId: string;
  readonly reason: PlaybackFinishReason;
  /** Optional native-side error description; only set when `reason === 'error'`. */
  readonly errorMessage?: string;
}

export interface FocusLossEvent {
  /**
   * Playback offset in milliseconds at the moment focus was lost. The
   * engine records this and uses it to resume from the same position
   * (Req 10.1, 10.2).
   */
  readonly capturedOffsetMs: number;
  /** Segment that was interrupted, if any. */
  readonly segmentId?: string;
}

export interface FocusRegainEvent {
  readonly segmentId?: string;
}

export interface DuckingChangeEvent {
  /** Current ducking level, percentage in [0, 100]. */
  readonly percent: number;
}

/**
 * Discriminated union of the native-emitted events the wrapper
 * normalizes into a single subscription stream. Mirrors the per-listener
 * methods on the native turbo-module spec one-for-one so the wrapper's
 * `on('event', cb)` API is just dispatch over `kind`.
 */
export type AudioServiceEvent =
  | ({ kind: 'PlaybackFinished' } & PlaybackFinishedEvent)
  | ({ kind: 'FocusLoss' } & FocusLossEvent)
  | ({ kind: 'FocusRegain' } & FocusRegainEvent)
  | ({ kind: 'DuckingChange' } & DuckingChangeEvent);

export type AudioServiceEventKind = AudioServiceEvent['kind'];

/** Per-event-kind listener type, mapped from the union. */
export type AudioServiceListener<K extends AudioServiceEventKind> = (
  ev: Extract<AudioServiceEvent, { kind: K }>,
) => void;

/** Returned by `on(...)` so callers can detach without identity tracking. */
export type Unsubscribe = () => void;
