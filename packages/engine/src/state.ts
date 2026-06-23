// TourState discriminated union covering the Tour_Engine state machine.
//
// design.md does NOT publish a `TourState` type verbatim; the type is
// implied by the state diagram in "## State Machine" and by the engine
// responsibilities listed under "Components and Interfaces > Tour_Engine".
// This file pins down the runtime shape so subsequent reducer tasks
// (3.2+) have a contract to satisfy.
//
// All fields whose existence is INFERRED from design.md (rather than
// quoted verbatim) are marked with `@inferred`. Later tasks may extend
// or refine these. They MUST NOT be silently removed without an update
// to design.md.
//
// @see design.md "## State Machine"
// @see design.md "Components and Interfaces > Tour_Engine"
// @see Requirements 1.1 (consumed set + at-most-one-playing),
//      5.5 (smoothed updates), 13.2 (cached entitlements),
//      14.2 (entitlement-aware dispatch), 15.1 (capability flags).

import type { AcceptedUpdate, Entitlement, Geofence } from './types';

/**
 * Identifier of the bundle currently driving the tour. The engine never
 * reads from disk; this is just the handle the reducer carries so that
 * `RequestDecryptedSegment` commands can be addressed correctly.
 *
 * @inferred from design.md "Components and Interfaces > Tour_Engine"
 *           and the `RequestDecryptedSegment` command shape.
 */
export interface BundleRef {
  bundleId: string;
  bundleVersion: string;
}

/**
 * The currently-playing segment, if any. The engine enforces the
 * single-segment invariant `|playing| <= 1` (Req 1.3), so this is
 * either present or absent — never an array.
 *
 * @inferred from design.md "Components and Interfaces > Tour_Engine"
 *           single-segment invariant note.
 */
export interface PlayingSegment {
  segmentId: string;
  /** The POI that triggered this segment, used to mark consumed on finish. */
  poiId: string;
  /** Wall-clock ms when playback was dispatched. */
  startedAtMs: number;
}

/**
 * Per-session context the reducer carries across every non-Idle phase.
 * Lifted out of the per-phase variants because every phase except
 * `Idle` shares it; this avoids restating the shape in five places.
 *
 * @inferred composition of per-phase fields the reducer needs in
 *           multiple phases.
 */
export interface TourSession {
  bundle: BundleRef;
  /** Geofences armed for this session. */
  geofences: readonly Geofence[];
  /** POIs whose segment has finished playing in this session (Req 1.4–1.5). */
  consumed: ReadonlySet<string>;
  /** At most one segment may be playing at any time (Req 1.3). */
  playing?: PlayingSegment;
  /** Most recent accepted (smoothed, projected) location update, if any. */
  lastAccepted?: AcceptedUpdate;
  /** Last entitlement snapshot pushed via `EntitlementsChanged` (Req 13.2, 14.2). */
  entitlements: readonly Entitlement[];
  /**
   * Set while a Route_Deviation prompt is outstanding. POI triggers are
   * suppressed while this is true (Req 8.3) regardless of the underlying
   * phase, so the reducer can check this flag without unwrapping the
   * variant.
   *
   * @inferred from design.md "## State Machine" deviation-suppression note
   *           and Requirement 8.3.
   */
  deviationPending: boolean;
  /**
   * User-selected language (ISO 639-1) for narrative dispatch. Drives the
   * pre-rendered/TTS/default-language fallback chain in audio source
   * selection (Property 9).
   *
   * @inferred from design.md "Audio source selection follows pre-rendered
   *           availability and language fallback".
   */
  currentLanguage: string;
  /**
   * When `true`, the GTFS feed is older than 90 days and the engine MUST
   * NOT enter Dead_Reckoning mode. Set at tour start from the GTFS age
   * policy evaluation and remains constant for the session lifetime.
   *
   * @see Requirement 18.4
   * @see evaluateGtfsAgePolicy in @tramio/storage/gtfs
   */
  drDisabled: boolean;
  /**
   * Wall-clock ms at which audio focus was lost. Used to determine whether
   * to resume or discard the playing segment on FocusRegain. Cleared on
   * regain or after the 10-minute timeout.
   *
   * @inferred from design.md "Audio_Service > Audio focus loss / regain
   *           handling with offset capture".
   */
  focusLostAtMs?: number;
  /**
   * Playback offset in ms captured at the moment of focus loss. The native
   * side tracks the actual offset; this field is reserved for future use.
   *
   * @inferred from design.md "Audio_Service > Audio focus loss / regain
   *           handling with offset capture".
   */
  pausedOffsetMs?: number;
}

/** No active tour. Engine waits for `UserCommand('start')`. */
export interface IdleState {
  phase: 'Idle';
}

/**
 * Tour is running, GPS is healthy, geofence pipeline is live.
 * Transitions to Standby (slow), DeadReckoning (signal loss),
 * Deviation (off-route), or Ended (user command).
 */
export interface ActiveState {
  phase: 'Active';
  session: TourSession;
}

/**
 * Tour is running but the vehicle is stationary or near-stationary.
 * Standby_Track may be scheduled. Resumes to Active on motion or a
 * geofence dwell event (Req 7.1–7.2).
 *
 * @inferred Track-id / scheduling fields will be filled in by the
 *           Standby_Track scheduler in task 3.x; deferred until then.
 */
export interface StandbyState {
  phase: 'Standby';
  session: TourSession;
  /** Trivia / ambient track currently scheduled, if any. @inferred */
  standbyTrackId?: string;
}

/**
 * No accepted GPS for >= 15s; engine advances position by GTFS
 * schedule until reconciled (Req 6.1–6.5).
 *
 * @inferred The reducer needs the wall-clock instant at which DR
 *           started so it can advance and so reconcile can detect
 *           missed POIs. Future tasks may also store the projected
 *           `alongRouteM` baseline.
 */
export interface DeadReckoningState {
  phase: 'DeadReckoning';
  session: TourSession;
  /** Wall-clock ms at which the engine entered DR. @inferred */
  enteredAtMs: number;
}

/**
 * User has drifted > 150m from the route for >= 60s. Deviation
 * prompt is visible; POI triggers are suppressed (Req 8.3).
 *
 * @inferred Prompt-visibility flag exists so the reducer can be
 *           idempotent across re-emissions of `ShowDeviationPrompt`,
 *           and so the host UI can be re-driven from state alone.
 */
export interface DeviationState {
  phase: 'Deviation';
  session: TourSession;
  /** Wall-clock ms at which deviation was detected. @inferred */
  detectedAtMs: number;
  /** Whether the deviation prompt is currently displayed. @inferred */
  promptVisible: boolean;
}

/**
 * Terminal phase before returning to Idle. The reducer emits
 * `ReleaseAll` here and waits up to 2s (Req 1.7) for the host to
 * confirm cleanup before transitioning back to Idle.
 *
 * @inferred Carries the wall-clock instant of the end command so the
 *           reducer can enforce the 2s release SLO.
 */
export interface EndedState {
  phase: 'Ended';
  /** Wall-clock ms at which the tour ended. @inferred */
  endedAtMs: number;
}

/**
 * Full Tour_Engine state. Mutually exclusive variants per design.md
 * "## State Machine". Standby is shown as a substate of Active in the
 * diagram but is encoded here as a distinct top-level variant for
 * straightforward exhaustiveness checks in the reducer.
 */
export type TourState =
  | IdleState
  | ActiveState
  | StandbyState
  | DeadReckoningState
  | DeviationState
  | EndedState;
