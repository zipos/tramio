// Tour_Engine pure reducer.
//
// The reducer is the heart of the Tour_Engine: a pure function
// `(state, event) -> (newState, commands[])`. It implements the state
// machine described in design.md "## State Machine" and enforces:
//
//   - Single-segment invariant: `|playing| <= 1` (Req 1.3)
//   - Consumed-set tracking: once a POI fires, it is added to the
//     consumed set and short-circuits before stage 4 (Req 1.4, 1.5)
//   - Tour-end resource release via `ReleaseAll` within 2s (Req 1.7)
//   - POI trigger suppression during deviation (Req 8.3)
//   - Standby_Track pause on POI trigger (Req 7.3)
//
// @see design.md "## State Machine"
// @see Requirements 1.1, 1.3, 1.4, 1.5, 1.7, 7.3, 8.3

import type { EngineCommand } from './commands';
import type { EngineEvent } from './events';
import type {
  ActiveState,
  BundleRef,
  DeadReckoningState,
  DeviationState,
  EndedState,
  IdleState,
  PlayingSegment,
  StandbyState,
  TourSession,
  TourState,
} from './state';
import type { AcceptedUpdate, Geofence } from './types';
import { resolveOverlappingTriggers } from './priority';

// ─── Result type ────────────────────────────────────────────────────────────

/** The output of a single reducer step: a new state plus zero or more commands. */
export interface ReducerResult {
  state: TourState;
  commands: readonly EngineCommand[];
}

// ─── Configuration passed at tour start ─────────────────────────────────────

/**
 * Minimal bundle configuration the reducer needs to start a tour.
 * The caller (command translator / host) resolves the full bundle and
 * passes this subset in via the `start` helper or directly.
 */
export interface StartTourConfig {
  bundle: BundleRef;
  geofences: readonly Geofence[];
  /** Route polyline for deviation detection (future tasks). */
  route: readonly [number, number][];
  /** User-selected language (ISO 639-1). */
  language: string;
  /**
   * When `true`, the GTFS feed is older than 90 days and the engine
   * MUST NOT enter Dead_Reckoning mode (Req 18.4). Derived from
   * `evaluateGtfsAgePolicy(feed).drDisabled` at tour start.
   */
  drDisabled?: boolean;
}

// ─── Initial state ──────────────────────────────────────────────────────────

/** The engine starts in Idle. */
export const INITIAL_STATE: IdleState = { phase: 'Idle' };

// ─── Reducer ────────────────────────────────────────────────────────────────

/**
 * Pure reducer: `(state, event, now?) -> ReducerResult`.
 *
 * `now` is the wall-clock instant (ms since epoch) at the time the event
 * is processed. It defaults to `Date.now()` in production but is injected
 * in tests for determinism.
 *
 * `config` is required only for the `UserCommand('start')` transition
 * from Idle → Active. It carries the bundle metadata and geofences the
 * session needs. For all other events it may be omitted.
 */
export function reduce(
  state: TourState,
  event: EngineEvent,
  now: number = Date.now(),
  config?: StartTourConfig,
): ReducerResult {
  switch (state.phase) {
    case 'Idle':
      return reduceIdle(state, event, now, config);
    case 'Active':
      return reduceActive(state, event, now);
    case 'Standby':
      return reduceStandby(state, event, now);
    case 'DeadReckoning':
      return reduceDeadReckoning(state, event, now);
    case 'Deviation':
      return reduceDeviation(state, event, now);
    case 'Ended':
      return reduceEnded(state, event, now);
  }
}

// ─── Per-phase reducers ─────────────────────────────────────────────────────

function reduceIdle(
  state: IdleState,
  event: EngineEvent,
  now: number,
  config?: StartTourConfig,
): ReducerResult {
  if (event.kind === 'UserCommand' && event.cmd === 'start' && config) {
    const session: TourSession = {
      bundle: config.bundle,
      geofences: config.geofences,
      consumed: new Set(),
      entitlements: [],
      deviationPending: false,
      currentLanguage: config.language,
      drDisabled: config.drDisabled ?? false,
    };
    const active: ActiveState = { phase: 'Active', session };
    return {
      state: active,
      commands: [{ kind: 'RequestLocationMode', mode: 'tour-bg' }],
    };
  }
  // All other events are no-ops in Idle.
  return { state, commands: [] };
}

function reduceActive(state: ActiveState, event: EngineEvent, now: number): ReducerResult {
  // UserCommand('end') → Ended + ReleaseAll (Req 1.7)
  if (event.kind === 'UserCommand' && event.cmd === 'end') {
    return transitionToEnded(now);
  }

  // AudioFinished: mark POI consumed, clear playing (Req 1.4)
  if (event.kind === 'AudioFinished') {
    const nextSession = handleAudioFinished(state.session, event.segmentId);
    return { state: { phase: 'Active', session: nextSession }, commands: [] };
  }

  // LocationAccepted: update lastAccepted on session
  if (event.kind === 'LocationAccepted') {
    const nextSession = updateLastAccepted(state.session, event.update);
    return { state: { phase: 'Active', session: nextSession }, commands: [] };
  }

  // Timer('dr-entry'): transition to DeadReckoning unless drDisabled (Req 6.1, 18.4)
  if (event.kind === 'Timer' && event.id === 'dr-entry') {
    // GTFS age policy enforcement: suppress DR entry when feed is > 90 days old (Req 18.4)
    if (state.session.drDisabled) {
      return { state, commands: [] };
    }
    const drState: DeadReckoningState = {
      phase: 'DeadReckoning',
      session: state.session,
      enteredAtMs: now,
    };
    return {
      state: drState,
      commands: [{ kind: 'RequestLocationMode', mode: 'reconcile' }],
    };
  }

  // GeofenceDwell: attempt to fire a POI trigger
  if (event.kind === 'GeofenceDwell') {
    return handleGeofenceDwell(state, event.poiId, now);
  }

  // EntitlementsChanged: update cached entitlements
  if (event.kind === 'EntitlementsChanged') {
    const nextSession = updateEntitlements(state.session, event.entitlements);
    return { state: { phase: 'Active', session: nextSession }, commands: [] };
  }

  // FocusLoss: pause audio if playing, record timestamp
  if (event.kind === 'FocusLoss') {
    return handleFocusLoss(state.session, 'Active', now);
  }

  // FocusRegain: resume or discard based on elapsed time
  if (event.kind === 'FocusRegain') {
    return handleFocusRegain(state.session, 'Active', now);
  }

  return { state, commands: [] };
}

function reduceStandby(state: StandbyState, event: EngineEvent, now: number): ReducerResult {
  // UserCommand('end') → Ended + ReleaseAll (Req 1.7)
  if (event.kind === 'UserCommand' && event.cmd === 'end') {
    return transitionToEnded(now);
  }

  // AudioFinished: mark POI consumed, clear playing (Req 1.4)
  if (event.kind === 'AudioFinished') {
    const nextSession = handleAudioFinished(state.session, event.segmentId);
    const nextState: StandbyState = { phase: 'Standby', session: nextSession };
    if (state.standbyTrackId !== undefined) {
      nextState.standbyTrackId = state.standbyTrackId;
    }
    return { state: nextState, commands: [] };
  }

  // LocationAccepted: update lastAccepted
  if (event.kind === 'LocationAccepted') {
    const nextSession = updateLastAccepted(state.session, event.update);
    const nextState: StandbyState = { phase: 'Standby', session: nextSession };
    if (state.standbyTrackId !== undefined) {
      nextState.standbyTrackId = state.standbyTrackId;
    }
    return { state: nextState, commands: [] };
  }

  // GeofenceDwell: POI trigger resumes to Active, stops standby (Req 7.3)
  if (event.kind === 'GeofenceDwell') {
    return handleGeofenceDwellFromStandby(state, event.poiId, now);
  }

  // EntitlementsChanged: update cached entitlements
  if (event.kind === 'EntitlementsChanged') {
    const nextSession = updateEntitlements(state.session, event.entitlements);
    const nextState: StandbyState = { phase: 'Standby', session: nextSession };
    if (state.standbyTrackId !== undefined) {
      nextState.standbyTrackId = state.standbyTrackId;
    }
    return { state: nextState, commands: [] };
  }

  // FocusLoss: pause audio if playing, record timestamp
  if (event.kind === 'FocusLoss') {
    return handleFocusLoss(state.session, 'Standby', now, state.standbyTrackId);
  }

  // FocusRegain: resume or discard based on elapsed time
  if (event.kind === 'FocusRegain') {
    return handleFocusRegain(state.session, 'Standby', now, state.standbyTrackId);
  }

  return { state, commands: [] };
}

function reduceDeadReckoning(
  state: DeadReckoningState,
  event: EngineEvent,
  now: number,
): ReducerResult {
  // UserCommand('end') → Ended + ReleaseAll (Req 1.7)
  if (event.kind === 'UserCommand' && event.cmd === 'end') {
    return transitionToEnded(now);
  }

  // AudioFinished: mark POI consumed, clear playing (Req 1.4)
  if (event.kind === 'AudioFinished') {
    const nextSession = handleAudioFinished(state.session, event.segmentId);
    return {
      state: { phase: 'DeadReckoning', session: nextSession, enteredAtMs: state.enteredAtMs },
      commands: [],
    };
  }

  // LocationAccepted: reconcile — return to Active (Req 6.4)
  if (event.kind === 'LocationAccepted') {
    const nextSession = updateLastAccepted(state.session, event.update);
    return {
      state: { phase: 'Active', session: nextSession },
      commands: [{ kind: 'RequestLocationMode', mode: 'tour-bg' }],
    };
  }

  // EntitlementsChanged: update cached entitlements
  if (event.kind === 'EntitlementsChanged') {
    const nextSession = updateEntitlements(state.session, event.entitlements);
    return {
      state: { phase: 'DeadReckoning', session: nextSession, enteredAtMs: state.enteredAtMs },
      commands: [],
    };
  }

  // FocusLoss: pause audio if playing, record timestamp
  if (event.kind === 'FocusLoss') {
    return handleFocusLossDeadReckoning(state, now);
  }

  // FocusRegain: resume or discard based on elapsed time
  if (event.kind === 'FocusRegain') {
    return handleFocusRegainDeadReckoning(state, now);
  }

  return { state, commands: [] };
}

function reduceDeviation(state: DeviationState, event: EngineEvent, now: number): ReducerResult {
  // UserCommand('end') or UserCommand('switch-route') → Ended (Req 8.5)
  if (event.kind === 'UserCommand' && (event.cmd === 'end' || event.cmd === 'switch-route')) {
    return transitionToEnded(now);
  }

  // UserCommand('resume-route') → Active (Req 8.4)
  // Note: the full implementation checks that the user is within 75m of
  // the route. For this task we implement the state transition; the
  // distance check is deferred to task 3.14.
  if (event.kind === 'UserCommand' && event.cmd === 'resume-route') {
    const nextSession: TourSession = { ...state.session, deviationPending: false };
    return {
      state: { phase: 'Active', session: nextSession },
      commands: [{ kind: 'HideDeviationPrompt' }, { kind: 'RequestLocationMode', mode: 'tour-bg' }],
    };
  }

  // Timer for 5-minute auto-end (Req 8.5)
  if (event.kind === 'Timer' && event.id === 'deviation-timeout') {
    return transitionToEnded(now);
  }

  // AudioFinished: mark POI consumed, clear playing
  if (event.kind === 'AudioFinished') {
    const nextSession = handleAudioFinished(state.session, event.segmentId);
    return {
      state: {
        phase: 'Deviation',
        session: nextSession,
        detectedAtMs: state.detectedAtMs,
        promptVisible: state.promptVisible,
      },
      commands: [],
    };
  }

  // EntitlementsChanged: update cached entitlements
  if (event.kind === 'EntitlementsChanged') {
    const nextSession = updateEntitlements(state.session, event.entitlements);
    return {
      state: {
        phase: 'Deviation',
        session: nextSession,
        detectedAtMs: state.detectedAtMs,
        promptVisible: state.promptVisible,
      },
      commands: [],
    };
  }

  // POI triggers are suppressed during deviation (Req 8.3) — no-op
  if (event.kind === 'GeofenceDwell') {
    return { state, commands: [] };
  }

  return { state, commands: [] };
}

function reduceEnded(state: EndedState, event: EngineEvent, _now: number): ReducerResult {
  // Timer('release-timeout') → back to Idle (Req 1.7: within 2s)
  if (event.kind === 'Timer' && event.id === 'release-timeout') {
    return { state: { phase: 'Idle' }, commands: [] };
  }
  // All other events are no-ops in Ended.
  return { state, commands: [] };
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Transition to Ended: emit ReleaseAll + schedule a 2s release timeout.
 * The reducer returns to Idle when the timer fires (Req 1.7).
 */
function transitionToEnded(now: number): ReducerResult {
  const ended: EndedState = { phase: 'Ended', endedAtMs: now };
  return {
    state: ended,
    commands: [
      { kind: 'StopAudio' },
      { kind: 'ReleaseAll' },
      { kind: 'RequestLocationMode', mode: 'idle' },
      { kind: 'ScheduleTimer', id: 'release-timeout', afterMs: 2000 },
    ],
  };
}

/**
 * Handle AudioFinished: clear the playing segment and add the POI to
 * the consumed set (Req 1.4). Enforces the consumed-set invariant.
 */
function handleAudioFinished(session: TourSession, segmentId: string): TourSession {
  if (!session.playing || session.playing.segmentId !== segmentId) {
    // Stale or unknown segment finish — no-op.
    return session;
  }
  const consumed = new Set(session.consumed);
  consumed.add(session.playing.poiId);
  // Build a new session without the `playing` field (exactOptionalPropertyTypes)
  const { playing: _, ...rest } = session;
  return {
    ...rest,
    consumed,
  };
}

/**
 * Update the session's lastAccepted field with a new accepted update.
 */
function updateLastAccepted(session: TourSession, update: AcceptedUpdate): TourSession {
  return { ...session, lastAccepted: update };
}

/**
 * Update the session's entitlements cache.
 */
function updateEntitlements(
  session: TourSession,
  entitlements: readonly import('./types').Entitlement[],
): TourSession {
  return { ...session, entitlements };
}

/**
 * Handle a GeofenceDwell event in Active state.
 * Enforces:
 *   - Consumed-set short-circuit (Req 1.5)
 *   - Single-segment invariant (Req 1.3)
 *   - Deviation suppression (Req 8.3)
 *   - Priority comparator for overlapping triggers (Req 1.6)
 */
function handleGeofenceDwell(
  state: ActiveState,
  poiId: string,
  now: number,
): ReducerResult {
  const { session } = state;

  // Consumed-set short-circuit: already played → no-op (Req 1.5)
  if (session.consumed.has(poiId)) {
    return { state, commands: [] };
  }

  // Deviation suppression: POI triggers suppressed while deviation pending (Req 8.3)
  if (session.deviationPending) {
    return { state, commands: [] };
  }

  // Single-segment invariant: if something is already playing, skip (Req 1.3)
  if (session.playing) {
    return { state, commands: [] };
  }

  // Priority comparator: resolve overlapping triggers (Req 1.6)
  // If we have a last known position, check for overlapping geofences and
  // select the highest-priority POI. Lower-priority overlapping POIs are
  // marked as skipped (added to consumed set).
  let winnerPoiId = poiId;
  let skippedIds: readonly string[] = [];

  if (session.lastAccepted) {
    const resolution = resolveOverlappingTriggers(
      poiId,
      session.geofences,
      session.lastAccepted.smoothed,
      session.consumed,
    );
    winnerPoiId = resolution.winnerId;
    skippedIds = resolution.skippedIds;
  }

  // Build the new consumed set with skipped POIs added
  const consumed = new Set(session.consumed);
  for (const skipped of skippedIds) {
    consumed.add(skipped);
  }

  // Fire the winning POI: set playing, emit PlaySegment command.
  // Note: audio source selection (pre-rendered vs TTS) and entitlement
  // filtering are implemented in later tasks (3.16, 3.20). For now we
  // emit a basic PlaySegment with TTS source.
  const segmentId = `${winnerPoiId}:${session.currentLanguage}`;
  const playing: PlayingSegment = { segmentId, poiId: winnerPoiId, startedAtMs: now };
  const nextSession: TourSession = { ...session, playing, consumed };

  return {
    state: { phase: 'Active', session: nextSession },
    commands: [{ kind: 'PlaySegment', segmentId, source: 'tts' }],
  };
}

/**
 * Handle a GeofenceDwell event from Standby state.
 * Transitions back to Active, stops standby track (Req 7.3), and fires POI.
 * Uses priority comparator for overlapping triggers (Req 1.6).
 */
function handleGeofenceDwellFromStandby(
  state: StandbyState,
  poiId: string,
  now: number,
): ReducerResult {
  const { session } = state;

  // Consumed-set short-circuit (Req 1.5)
  if (session.consumed.has(poiId)) {
    return { state, commands: [] };
  }

  // Deviation suppression (Req 8.3)
  if (session.deviationPending) {
    return { state, commands: [] };
  }

  // Stop standby track and transition to Active (Req 7.3)
  const commands: EngineCommand[] = [];

  // If a standby track is playing, stop it first
  if (state.standbyTrackId) {
    commands.push({ kind: 'StopAudio' });
  }

  // Single-segment invariant: if something is already playing, just transition
  if (session.playing) {
    return {
      state: { phase: 'Active', session },
      commands,
    };
  }

  // Priority comparator: resolve overlapping triggers (Req 1.6)
  let winnerPoiId = poiId;
  let skippedIds: readonly string[] = [];

  if (session.lastAccepted) {
    const resolution = resolveOverlappingTriggers(
      poiId,
      session.geofences,
      session.lastAccepted.smoothed,
      session.consumed,
    );
    winnerPoiId = resolution.winnerId;
    skippedIds = resolution.skippedIds;
  }

  // Build the new consumed set with skipped POIs added
  const consumed = new Set(session.consumed);
  for (const skipped of skippedIds) {
    consumed.add(skipped);
  }

  // Fire the winning POI
  const segmentId = `${winnerPoiId}:${session.currentLanguage}`;
  const playing: PlayingSegment = { segmentId, poiId: winnerPoiId, startedAtMs: now };
  const nextSession: TourSession = { ...session, playing, consumed };

  commands.push({ kind: 'PlaySegment', segmentId, source: 'tts' });

  return {
    state: { phase: 'Active', session: nextSession },
    commands,
  };
}

// ─── Focus Loss / Regain helpers ────────────────────────────────────────────

/** 10 minutes in milliseconds — threshold for discarding a paused segment. */
const FOCUS_LOSS_TIMEOUT_MS = 600_000;

/**
 * Handle FocusLoss for Active and Standby states.
 * If a segment is playing, emit PauseAudio and record focusLostAtMs.
 */
function handleFocusLoss(
  session: TourSession,
  phase: 'Active' | 'Standby',
  now: number,
  standbyTrackId?: string,
): ReducerResult {
  const commands: EngineCommand[] = [];

  if (session.playing) {
    commands.push({ kind: 'PauseAudio' });
  }

  const nextSession: TourSession = { ...session, focusLostAtMs: now };

  if (phase === 'Standby') {
    const nextState: StandbyState = { phase: 'Standby', session: nextSession };
    if (standbyTrackId !== undefined) {
      nextState.standbyTrackId = standbyTrackId;
    }
    return { state: nextState, commands };
  }

  return { state: { phase: 'Active', session: nextSession }, commands };
}

/**
 * Handle FocusRegain for Active and Standby states.
 * If focusLostAtMs exists and gap < 10 minutes, emit ResumeAudio and clear.
 * If gap >= 10 minutes, discard the segment (clear playing and focusLostAtMs).
 */
function handleFocusRegain(
  session: TourSession,
  phase: 'Active' | 'Standby',
  now: number,
  standbyTrackId?: string,
): ReducerResult {
  if (session.focusLostAtMs == null) {
    // No recorded focus loss — no-op
    if (phase === 'Standby') {
      const nextState: StandbyState = { phase: 'Standby', session };
      if (standbyTrackId !== undefined) {
        nextState.standbyTrackId = standbyTrackId;
      }
      return { state: nextState, commands: [] };
    }
    return { state: { phase: 'Active', session }, commands: [] };
  }

  const elapsed = now - session.focusLostAtMs;
  const commands: EngineCommand[] = [];

  if (elapsed < FOCUS_LOSS_TIMEOUT_MS) {
    // Resume playback — native side tracks the actual offset
    commands.push({ kind: 'ResumeAudio', offsetMs: 0 });
    const { focusLostAtMs: _, pausedOffsetMs: __, ...rest } = session;
    const nextSession: TourSession = { ...rest };

    if (phase === 'Standby') {
      const nextState: StandbyState = { phase: 'Standby', session: nextSession };
      if (standbyTrackId !== undefined) {
        nextState.standbyTrackId = standbyTrackId;
      }
      return { state: nextState, commands };
    }
    return { state: { phase: 'Active', session: nextSession }, commands };
  }

  // Gap >= 10 minutes: discard the playing segment
  const { focusLostAtMs: _, pausedOffsetMs: __, playing: ___, ...rest } = session;
  const nextSession: TourSession = { ...rest };

  if (phase === 'Standby') {
    const nextState: StandbyState = { phase: 'Standby', session: nextSession };
    if (standbyTrackId !== undefined) {
      nextState.standbyTrackId = standbyTrackId;
    }
    return { state: nextState, commands };
  }
  return { state: { phase: 'Active', session: nextSession }, commands };
}

/**
 * Handle FocusLoss in DeadReckoning state.
 */
function handleFocusLossDeadReckoning(state: DeadReckoningState, now: number): ReducerResult {
  const commands: EngineCommand[] = [];

  if (state.session.playing) {
    commands.push({ kind: 'PauseAudio' });
  }

  const nextSession: TourSession = { ...state.session, focusLostAtMs: now };
  return {
    state: { phase: 'DeadReckoning', session: nextSession, enteredAtMs: state.enteredAtMs },
    commands,
  };
}

/**
 * Handle FocusRegain in DeadReckoning state.
 */
function handleFocusRegainDeadReckoning(state: DeadReckoningState, now: number): ReducerResult {
  const { session } = state;

  if (session.focusLostAtMs == null) {
    return { state, commands: [] };
  }

  const elapsed = now - session.focusLostAtMs;
  const commands: EngineCommand[] = [];

  if (elapsed < FOCUS_LOSS_TIMEOUT_MS) {
    commands.push({ kind: 'ResumeAudio', offsetMs: 0 });
    const { focusLostAtMs: _, pausedOffsetMs: __, ...rest } = session;
    const nextSession: TourSession = { ...rest };
    return {
      state: { phase: 'DeadReckoning', session: nextSession, enteredAtMs: state.enteredAtMs },
      commands,
    };
  }

  // Gap >= 10 minutes: discard the playing segment
  const { focusLostAtMs: _, pausedOffsetMs: __, playing: ___, ...rest } = session;
  const nextSession: TourSession = { ...rest };
  return {
    state: { phase: 'DeadReckoning', session: nextSession, enteredAtMs: state.enteredAtMs },
    commands,
  };
}
