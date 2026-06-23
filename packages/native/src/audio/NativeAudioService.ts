// Audio_Service turbo-module TypeScript spec.
//
// This file declares the JS surface of the native turbo module. It does
// NOT pull in `react-native` so it can be type-checked in isolation
// (the package is a pure-TS target consumed by tests, the engine
// command translator, and — eventually — the RN turbo-module codegen).
//
// The native iOS implementation lives at
//   packages/native/ios/Audio/TramioAudioService.{h,m}
// and the Android implementation lands in task 8.4. Both bind to this
// same TS shape so the engine's command translator (task 13.1) can be
// platform-agnostic.
//
// @see design.md "Components and Interfaces > Audio_Service"
// @see design.md "Data Models > Runtime types (TypeScript)"
//      ("RequestDecryptedSegment" + plaintext-free playback path)
// @see Requirements 9.3, 10.1, 10.2, 10.3, 10.4, 12.1, 15.1

import type {
  DuckingChangeEvent,
  FocusLossEvent,
  FocusRegainEvent,
  PlayOptions,
  PlaybackFinishedEvent,
} from './types';

/**
 * Spec object the native bridge implements. The `Spec` typename and the
 * "Native…" prefix on the file follow the React Native turbo-module
 * codegen convention so the same TS file can be promoted to a codegen
 * spec when we wire actual RN host objects (task 13.1 wiring + future
 * codegen work). Keeping the conventions stable now means task 13.1
 * does not have to rename anything.
 *
 * Naming:
 *   - Methods on this interface are exactly the methods exposed by
 *     `RCTBridgeModule` on iOS. The wrapper (`AudioService` in
 *     `./AudioService.ts`) layers ergonomic types and source-handle
 *     resolution on top, so consumers (the engine translator) never
 *     interact with this raw spec.
 *
 * The `sourceJson` argument carries a JSON-serialized
 * {@link import('./types').AudioSource}. We pass it as a string rather
 * than a structured object because RN's bridge codec has historically
 * been flaky with discriminated unions; the wrapper does the
 * (de)serialization so the call site stays typed.
 */
export interface Spec {
  /**
   * Play `source` as the single active segment. Implementations MUST
   * stop any currently-playing segment first to preserve the engine's
   * `|playing| <= 1` invariant (Req 1.3).
   */
  play(segmentId: string, sourceJson: string, optsJson: string): Promise<void>;

  /**
   * Pause the current segment and capture the playback offset in ms.
   * Resolves with the captured offset so the JS-side engine can record
   * it for `ResumeAudio` (Req 10.1).
   */
  pause(): Promise<number>;

  /**
   * Resume the previously paused segment from `offsetMs`. If no segment
   * is paused, implementations MUST resolve without throwing so the
   * command is idempotent under repeated `ResumeAudio` events.
   */
  resume(offsetMs: number): Promise<void>;

  /**
   * Stop and release any currently-playing segment. Idempotent.
   */
  stop(): Promise<void>;

  /**
   * Set the ducking level. `percent` must be clamped to `[0, 100]` by
   * the implementation. A value of 0 restores nominal volume; values
   * `>= 50` satisfy the "at least 50% reduction" rule (Req 10.4).
   */
  duck(percent: number): Promise<void>;

  /**
   * Subscribe to `onPlaybackFinished`. Implementations return a
   * subscription token (opaque string) that the wrapper uses to detach.
   * Returned token MUST round-trip through `removeListener`.
   */
  addPlaybackFinishedListener(callback: (ev: PlaybackFinishedEvent) => void): string;
  addFocusLossListener(callback: (ev: FocusLossEvent) => void): string;
  addFocusRegainListener(callback: (ev: FocusRegainEvent) => void): string;
  addDuckingChangeListener(callback: (ev: DuckingChangeEvent) => void): string;

  /** Detach a previously-added listener token. Idempotent. */
  removeListener(token: string): void;
}

/**
 * Default `PlayOptions` applied when the caller passes `undefined` for
 * a field. Centralized here (rather than inlined in `AudioService.play`)
 * so the wrapper's behavior matches what the native side observes when
 * codegen eventually owns the defaulting.
 */
export const DEFAULT_PLAY_OPTIONS: Required<PlayOptions> = Object.freeze({
  startOffsetMs: 0,
  gainOffsetDb: 0,
  initialDuckPercent: 0,
});

/**
 * Hard limits on `gainOffsetDb`. The MVP catalog does not measure real
 * LUFS; an over-eager offset can clip the speaker. ±12 dB is the
 * tolerance band the catalog SHOULD stay inside; values outside are
 * clamped silently and logged on the native side.
 *
 * @see Requirement 9.3 (target ~ -16 LUFS ±3 dB)
 */
export const GAIN_OFFSET_DB_MIN = -12;
export const GAIN_OFFSET_DB_MAX = 12;

/** Hard limits on the duck percentage parameter. */
export const DUCK_PERCENT_MIN = 0;
export const DUCK_PERCENT_MAX = 100;

/**
 * Threshold at which a duck is considered "active" for the purposes of
 * the >= 50% rule (Req 10.4). Exposed as a constant so the wrapper and
 * tests share the same value.
 */
export const DUCK_ACTIVE_THRESHOLD_PERCENT = 50;
