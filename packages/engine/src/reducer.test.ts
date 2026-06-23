// Unit tests for the Tour_Engine state machine reducer.
//
// Covers:
//   - State transitions (Idle → Active → Ended, etc.)
//   - Single-segment invariant (Req 1.3)
//   - Consumed-set tracking (Req 1.4, 1.5)
//   - Tour-end resource release via ReleaseAll (Req 1.7)
//   - POI trigger suppression during deviation (Req 8.3)
//   - Standby → Active on POI trigger with StopAudio (Req 7.3)

import type { EngineEvent } from './events';
import type {
  ActiveState,
  DeadReckoningState,
  DeviationState,
  EndedState,
  StandbyState,
  TourSession,
} from './state';
import type { AcceptedUpdate, Geofence } from './types';
import { INITIAL_STATE, reduce } from './reducer';
import type { StartTourConfig } from './reducer';

// ─── Test helpers ───────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

const TEST_GEOFENCES: readonly Geofence[] = [
  {
    poiId: 'poi-1',
    geometry: { kind: 'circle', center: [51.11, 17.03], radiusMeters: 60 },
    dwellSec: 3,
    priority: 90,
    authorIndex: 0,
  },
  {
    poiId: 'poi-2',
    geometry: { kind: 'circle', center: [51.12, 17.04], radiusMeters: 50 },
    dwellSec: 3,
    priority: 80,
    authorIndex: 1,
  },
];

const TEST_CONFIG: StartTourConfig = {
  bundle: { bundleId: 'test-bundle', bundleVersion: '1.0.0' },
  geofences: TEST_GEOFENCES,
  route: [
    [51.11, 17.03],
    [51.12, 17.04],
  ],
  language: 'en',
};

function makeSession(overrides: Partial<TourSession> = {}): TourSession {
  return {
    bundle: { bundleId: 'test-bundle', bundleVersion: '1.0.0' },
    geofences: TEST_GEOFENCES,
    consumed: new Set(),
    entitlements: [],
    deviationPending: false,
    currentLanguage: 'en',
    drDisabled: false,
    ...overrides,
  };
}

function makeActiveState(sessionOverrides: Partial<TourSession> = {}): ActiveState {
  return { phase: 'Active', session: makeSession(sessionOverrides) };
}

function makeAcceptedUpdate(overrides: Partial<AcceptedUpdate> = {}): AcceptedUpdate {
  return {
    ts: NOW,
    coord: [51.11, 17.03],
    accuracyM: 10,
    smoothed: [51.11, 17.03],
    alongRouteM: 0,
    ...overrides,
  };
}

// ─── Idle state ─────────────────────────────────────────────────────────────

describe('Idle state', () => {
  it('transitions to Active on UserCommand(start) with valid config', () => {
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'start' };
    const result = reduce(INITIAL_STATE, event, NOW, TEST_CONFIG);

    expect(result.state.phase).toBe('Active');
    expect(result.commands).toContainEqual({ kind: 'RequestLocationMode', mode: 'tour-bg' });
  });

  it('stays Idle on UserCommand(start) without config', () => {
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'start' };
    const result = reduce(INITIAL_STATE, event, NOW);

    expect(result.state.phase).toBe('Idle');
    expect(result.commands).toHaveLength(0);
  });

  it('ignores non-start events', () => {
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'end' };
    const result = reduce(INITIAL_STATE, event, NOW);

    expect(result.state.phase).toBe('Idle');
    expect(result.commands).toHaveLength(0);
  });

  it('initializes session with empty consumed set', () => {
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'start' };
    const result = reduce(INITIAL_STATE, event, NOW, TEST_CONFIG);

    const active = result.state as ActiveState;
    expect(active.session.consumed.size).toBe(0);
  });
});

// ─── Active state ───────────────────────────────────────────────────────────

describe('Active state', () => {
  describe('UserCommand(end)', () => {
    it('transitions to Ended and emits ReleaseAll (Req 1.7)', () => {
      const state = makeActiveState();
      const event: EngineEvent = { kind: 'UserCommand', cmd: 'end' };
      const result = reduce(state, event, NOW);

      expect(result.state.phase).toBe('Ended');
      expect(result.commands).toContainEqual({ kind: 'ReleaseAll' });
      expect(result.commands).toContainEqual({ kind: 'StopAudio' });
      expect(result.commands).toContainEqual({ kind: 'RequestLocationMode', mode: 'idle' });
    });

    it('schedules a 2s release timeout (Req 1.7)', () => {
      const state = makeActiveState();
      const event: EngineEvent = { kind: 'UserCommand', cmd: 'end' };
      const result = reduce(state, event, NOW);

      expect(result.commands).toContainEqual({
        kind: 'ScheduleTimer',
        id: 'release-timeout',
        afterMs: 2000,
      });
    });
  });

  describe('AudioFinished', () => {
    it('clears playing and adds POI to consumed set (Req 1.4)', () => {
      const state = makeActiveState({
        playing: { segmentId: 'poi-1:en', poiId: 'poi-1', startedAtMs: NOW - 5000 },
      });
      const event: EngineEvent = { kind: 'AudioFinished', segmentId: 'poi-1:en' };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.playing).toBeUndefined();
      expect(active.session.consumed.has('poi-1')).toBe(true);
    });

    it('ignores AudioFinished for unknown segment', () => {
      const state = makeActiveState({
        playing: { segmentId: 'poi-1:en', poiId: 'poi-1', startedAtMs: NOW - 5000 },
      });
      const event: EngineEvent = { kind: 'AudioFinished', segmentId: 'unknown' };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.playing).toBeDefined();
    });
  });

  describe('GeofenceDwell', () => {
    it('fires POI and sets playing (single-segment invariant Req 1.3)', () => {
      const state = makeActiveState();
      const event: EngineEvent = { kind: 'GeofenceDwell', poiId: 'poi-1' };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.playing).toBeDefined();
      expect(active.session.playing!.poiId).toBe('poi-1');
      expect(result.commands).toContainEqual(
        expect.objectContaining({ kind: 'PlaySegment', segmentId: 'poi-1:en' }),
      );
    });

    it('does NOT fire if POI is already consumed (Req 1.5)', () => {
      const state = makeActiveState({ consumed: new Set(['poi-1']) });
      const event: EngineEvent = { kind: 'GeofenceDwell', poiId: 'poi-1' };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.playing).toBeUndefined();
      expect(result.commands).toHaveLength(0);
    });

    it('does NOT fire if another segment is already playing (Req 1.3)', () => {
      const state = makeActiveState({
        playing: { segmentId: 'poi-2:en', poiId: 'poi-2', startedAtMs: NOW - 1000 },
      });
      const event: EngineEvent = { kind: 'GeofenceDwell', poiId: 'poi-1' };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.playing!.poiId).toBe('poi-2'); // unchanged
      expect(result.commands).toHaveLength(0);
    });

    it('does NOT fire if deviation is pending (Req 8.3)', () => {
      const state = makeActiveState({ deviationPending: true });
      const event: EngineEvent = { kind: 'GeofenceDwell', poiId: 'poi-1' };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.playing).toBeUndefined();
      expect(result.commands).toHaveLength(0);
    });
  });

  describe('LocationAccepted', () => {
    it('updates lastAccepted on session', () => {
      const state = makeActiveState();
      const update = makeAcceptedUpdate({ ts: NOW + 1000 });
      const event: EngineEvent = { kind: 'LocationAccepted', update };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.lastAccepted).toBe(update);
    });
  });

  describe('EntitlementsChanged', () => {
    it('updates entitlements on session', () => {
      const state = makeActiveState();
      const event: EngineEvent = {
        kind: 'EntitlementsChanged',
        entitlements: [{ tier: 'time_pass', expiryUtc: NOW + 86400000 }],
      };
      const result = reduce(state, event, NOW);

      const active = result.state as ActiveState;
      expect(active.session.entitlements).toHaveLength(1);
      expect(active.session.entitlements[0]!.tier).toBe('time_pass');
    });
  });
});

// ─── Standby state ──────────────────────────────────────────────────────────

describe('Standby state', () => {
  function makeStandbyState(
    sessionOverrides: Partial<TourSession> = {},
    standbyTrackId?: string,
  ): StandbyState {
    const state: StandbyState = {
      phase: 'Standby',
      session: makeSession(sessionOverrides),
    };
    if (standbyTrackId !== undefined) {
      state.standbyTrackId = standbyTrackId;
    }
    return state;
  }

  it('transitions to Ended on UserCommand(end) (Req 1.7)', () => {
    const state = makeStandbyState();
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'end' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Ended');
    expect(result.commands).toContainEqual({ kind: 'ReleaseAll' });
  });

  it('transitions to Active and stops standby on GeofenceDwell (Req 7.3)', () => {
    const state = makeStandbyState({}, 'trivia-architecture');
    const event: EngineEvent = { kind: 'GeofenceDwell', poiId: 'poi-1' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Active');
    expect(result.commands).toContainEqual({ kind: 'StopAudio' });
    expect(result.commands).toContainEqual(
      expect.objectContaining({ kind: 'PlaySegment', segmentId: 'poi-1:en' }),
    );
  });

  it('does NOT fire consumed POI from Standby (Req 1.5)', () => {
    const state = makeStandbyState({ consumed: new Set(['poi-1']) }, 'trivia-architecture');
    const event: EngineEvent = { kind: 'GeofenceDwell', poiId: 'poi-1' };
    const result = reduce(state, event, NOW);

    // Stays in Standby
    expect(result.state.phase).toBe('Standby');
    expect(result.commands).toHaveLength(0);
  });
});

// ─── DeadReckoning state ────────────────────────────────────────────────────

describe('DeadReckoning state', () => {
  function makeDRState(sessionOverrides: Partial<TourSession> = {}): DeadReckoningState {
    return {
      phase: 'DeadReckoning',
      session: makeSession(sessionOverrides),
      enteredAtMs: NOW - 15000,
    };
  }

  it('transitions to Ended on UserCommand(end) (Req 1.7)', () => {
    const state = makeDRState();
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'end' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Ended');
    expect(result.commands).toContainEqual({ kind: 'ReleaseAll' });
  });

  it('reconciles to Active on LocationAccepted (Req 6.4)', () => {
    const state = makeDRState();
    const update = makeAcceptedUpdate({ ts: NOW });
    const event: EngineEvent = { kind: 'LocationAccepted', update };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Active');
    expect(result.commands).toContainEqual({ kind: 'RequestLocationMode', mode: 'tour-bg' });
  });
});

// ─── DR entry suppression via GTFS age policy (Req 18.4) ───────────────────

describe('DR entry suppression (Req 18.4)', () => {
  it('transitions to DeadReckoning on dr-entry timer when drDisabled=false', () => {
    const state = makeActiveState({ drDisabled: false });
    const event: EngineEvent = { kind: 'Timer', id: 'dr-entry', firedAt: NOW };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('DeadReckoning');
    expect(result.commands).toContainEqual({ kind: 'RequestLocationMode', mode: 'reconcile' });
  });

  it('suppresses DR entry on dr-entry timer when drDisabled=true (Req 18.4)', () => {
    const state = makeActiveState({ drDisabled: true });
    const event: EngineEvent = { kind: 'Timer', id: 'dr-entry', firedAt: NOW };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Active');
    expect(result.commands).toHaveLength(0);
  });

  it('passes drDisabled from StartTourConfig into the session', () => {
    const config: StartTourConfig = {
      ...TEST_CONFIG,
      drDisabled: true,
    };
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'start' };
    const result = reduce(INITIAL_STATE, event, NOW, config);

    expect(result.state.phase).toBe('Active');
    const active = result.state as ActiveState;
    expect(active.session.drDisabled).toBe(true);
  });

  it('defaults drDisabled to false when not specified in StartTourConfig', () => {
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'start' };
    const result = reduce(INITIAL_STATE, event, NOW, TEST_CONFIG);

    expect(result.state.phase).toBe('Active');
    const active = result.state as ActiveState;
    expect(active.session.drDisabled).toBe(false);
  });
});

// ─── Deviation state ────────────────────────────────────────────────────────

describe('Deviation state', () => {
  function makeDeviationState(sessionOverrides: Partial<TourSession> = {}): DeviationState {
    return {
      phase: 'Deviation',
      session: makeSession({ deviationPending: true, ...sessionOverrides }),
      detectedAtMs: NOW - 60000,
      promptVisible: true,
    };
  }

  it('transitions to Ended on UserCommand(end)', () => {
    const state = makeDeviationState();
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'end' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Ended');
    expect(result.commands).toContainEqual({ kind: 'ReleaseAll' });
  });

  it('transitions to Ended on UserCommand(switch-route)', () => {
    const state = makeDeviationState();
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'switch-route' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Ended');
  });

  it('transitions to Active on UserCommand(resume-route) (Req 8.4)', () => {
    const state = makeDeviationState();
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'resume-route' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Active');
    expect(result.commands).toContainEqual({ kind: 'HideDeviationPrompt' });
    const active = result.state as ActiveState;
    expect(active.session.deviationPending).toBe(false);
  });

  it('transitions to Ended on deviation-timeout timer (Req 8.5)', () => {
    const state = makeDeviationState();
    const event: EngineEvent = { kind: 'Timer', id: 'deviation-timeout', firedAt: NOW };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Ended');
    expect(result.commands).toContainEqual({ kind: 'ReleaseAll' });
  });

  it('suppresses POI triggers during deviation (Req 8.3)', () => {
    const state = makeDeviationState();
    const event: EngineEvent = { kind: 'GeofenceDwell', poiId: 'poi-1' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Deviation');
    expect(result.commands).toHaveLength(0);
  });
});

// ─── Ended state ────────────────────────────────────────────────────────────

describe('Ended state', () => {
  function makeEndedState(): EndedState {
    return { phase: 'Ended', endedAtMs: NOW };
  }

  it('transitions to Idle on release-timeout timer (Req 1.7)', () => {
    const state = makeEndedState();
    const event: EngineEvent = { kind: 'Timer', id: 'release-timeout', firedAt: NOW + 2000 };
    const result = reduce(state, event, NOW + 2000);

    expect(result.state.phase).toBe('Idle');
  });

  it('ignores other events', () => {
    const state = makeEndedState();
    const event: EngineEvent = { kind: 'UserCommand', cmd: 'start' };
    const result = reduce(state, event, NOW);

    expect(result.state.phase).toBe('Ended');
    expect(result.commands).toHaveLength(0);
  });
});

// ─── Cross-cutting invariants ───────────────────────────────────────────────

describe('Cross-cutting invariants', () => {
  it('consumed set grows monotonically across multiple POI fires', () => {
    // Start tour
    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, TEST_CONFIG);
    expect(result.state.phase).toBe('Active');

    // Fire poi-1
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-1' }, NOW + 1000);
    const active1 = result.state as ActiveState;
    expect(active1.session.playing!.poiId).toBe('poi-1');

    // Finish poi-1
    result = reduce(result.state, { kind: 'AudioFinished', segmentId: 'poi-1:en' }, NOW + 5000);
    const active2 = result.state as ActiveState;
    expect(active2.session.consumed.has('poi-1')).toBe(true);
    expect(active2.session.playing).toBeUndefined();

    // Fire poi-2
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-2' }, NOW + 6000);
    const active3 = result.state as ActiveState;
    expect(active3.session.playing!.poiId).toBe('poi-2');

    // Finish poi-2
    result = reduce(result.state, { kind: 'AudioFinished', segmentId: 'poi-2:en' }, NOW + 10000);
    const active4 = result.state as ActiveState;
    expect(active4.session.consumed.has('poi-1')).toBe(true);
    expect(active4.session.consumed.has('poi-2')).toBe(true);
  });

  it('re-entering a consumed POI geofence does NOT replay (Req 1.5)', () => {
    // Start tour
    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, TEST_CONFIG);

    // Fire and finish poi-1
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-1' }, NOW + 1000);
    result = reduce(result.state, { kind: 'AudioFinished', segmentId: 'poi-1:en' }, NOW + 5000);

    // Re-enter poi-1 geofence
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-1' }, NOW + 20000);
    const active = result.state as ActiveState;
    expect(active.session.playing).toBeUndefined();
    expect(result.commands).toHaveLength(0);
  });

  it('full lifecycle: Idle → Active → Ended → Idle', () => {
    // Start
    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, TEST_CONFIG);
    expect(result.state.phase).toBe('Active');

    // End
    result = reduce(result.state, { kind: 'UserCommand', cmd: 'end' }, NOW + 10000);
    expect(result.state.phase).toBe('Ended');
    expect(result.commands).toContainEqual({ kind: 'ReleaseAll' });

    // Release timeout fires → Idle
    result = reduce(
      result.state,
      { kind: 'Timer', id: 'release-timeout', firedAt: NOW + 12000 },
      NOW + 12000,
    );
    expect(result.state.phase).toBe('Idle');
  });
});

// ─── Priority comparator integration (Req 1.6) ─────────────────────────────

describe('Priority comparator integration (Req 1.6)', () => {
  // Overlapping geofences: all centered at the same point
  const OVERLAP_CENTER: [number, number] = [51.11, 17.03];

  const OVERLAPPING_GEOFENCES: readonly Geofence[] = [
    {
      poiId: 'poi-high',
      geometry: { kind: 'circle', center: OVERLAP_CENTER, radiusMeters: 100 },
      dwellSec: 3,
      priority: 90,
      authorIndex: 0,
    },
    {
      poiId: 'poi-mid',
      geometry: { kind: 'circle', center: OVERLAP_CENTER, radiusMeters: 100 },
      dwellSec: 3,
      priority: 50,
      authorIndex: 1,
    },
    {
      poiId: 'poi-low',
      geometry: { kind: 'circle', center: OVERLAP_CENTER, radiusMeters: 100 },
      dwellSec: 3,
      priority: 20,
      authorIndex: 2,
    },
  ];

  const OVERLAP_CONFIG: StartTourConfig = {
    bundle: { bundleId: 'test-bundle', bundleVersion: '1.0.0' },
    geofences: OVERLAPPING_GEOFENCES,
    route: [OVERLAP_CENTER, [51.12, 17.04]],
    language: 'en',
  };

  it('selects highest-priority POI when overlapping triggers fire (Req 1.6)', () => {
    // Start tour and set lastAccepted at the overlap center
    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, OVERLAP_CONFIG);
    const update = makeAcceptedUpdate({ coord: OVERLAP_CENTER, smoothed: OVERLAP_CENTER });
    result = reduce(result.state, { kind: 'LocationAccepted', update }, NOW + 500);

    // Fire a lower-priority POI — the comparator should select the highest
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-mid' }, NOW + 1000);

    const active = result.state as ActiveState;
    expect(active.session.playing).toBeDefined();
    expect(active.session.playing!.poiId).toBe('poi-high');
    expect(result.commands).toContainEqual(
      expect.objectContaining({ kind: 'PlaySegment', segmentId: 'poi-high:en' }),
    );
  });

  it('marks lower-priority overlapping POIs as skipped (consumed)', () => {
    // Start tour and set lastAccepted at the overlap center
    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, OVERLAP_CONFIG);
    const update = makeAcceptedUpdate({ coord: OVERLAP_CENTER, smoothed: OVERLAP_CENTER });
    result = reduce(result.state, { kind: 'LocationAccepted', update }, NOW + 500);

    // Fire any POI — all overlap, so lower-priority ones get skipped
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-low' }, NOW + 1000);

    const active = result.state as ActiveState;
    // poi-mid and poi-low should be in consumed (skipped)
    expect(active.session.consumed.has('poi-mid')).toBe(true);
    expect(active.session.consumed.has('poi-low')).toBe(true);
    // poi-high should NOT be in consumed yet (it's playing)
    expect(active.session.consumed.has('poi-high')).toBe(false);
  });

  it('uses authorIndex as tie-breaker when priorities are equal', () => {
    const TIED_GEOFENCES: readonly Geofence[] = [
      {
        poiId: 'poi-later',
        geometry: { kind: 'circle', center: OVERLAP_CENTER, radiusMeters: 100 },
        dwellSec: 3,
        priority: 50,
        authorIndex: 3,
      },
      {
        poiId: 'poi-earlier',
        geometry: { kind: 'circle', center: OVERLAP_CENTER, radiusMeters: 100 },
        dwellSec: 3,
        priority: 50,
        authorIndex: 1,
      },
    ];

    const tiedConfig: StartTourConfig = {
      bundle: { bundleId: 'test-bundle', bundleVersion: '1.0.0' },
      geofences: TIED_GEOFENCES,
      route: [OVERLAP_CENTER, [51.12, 17.04]],
      language: 'en',
    };

    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, tiedConfig);
    const update = makeAcceptedUpdate({ coord: OVERLAP_CENTER, smoothed: OVERLAP_CENTER });
    result = reduce(result.state, { kind: 'LocationAccepted', update }, NOW + 500);

    // Fire the later-authored POI — earlier one should win
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-later' }, NOW + 1000);

    const active = result.state as ActiveState;
    expect(active.session.playing!.poiId).toBe('poi-earlier');
    expect(active.session.consumed.has('poi-later')).toBe(true);
  });

  it('does not apply priority resolution when no lastAccepted position exists', () => {
    // Start tour without setting lastAccepted
    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, OVERLAP_CONFIG);

    // Fire a POI — without lastAccepted, the triggered POI wins directly
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-mid' }, NOW + 1000);

    const active = result.state as ActiveState;
    expect(active.session.playing!.poiId).toBe('poi-mid');
    expect(active.session.consumed.has('poi-high')).toBe(false);
    expect(active.session.consumed.has('poi-low')).toBe(false);
  });

  it('skipped POIs do not replay on subsequent GeofenceDwell (Req 1.5)', () => {
    // Start tour and set lastAccepted at the overlap center
    let result = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, NOW, OVERLAP_CONFIG);
    const update = makeAcceptedUpdate({ coord: OVERLAP_CENTER, smoothed: OVERLAP_CENTER });
    result = reduce(result.state, { kind: 'LocationAccepted', update }, NOW + 500);

    // Fire — poi-high wins, poi-mid and poi-low are skipped
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-low' }, NOW + 1000);

    // Finish poi-high
    result = reduce(result.state, { kind: 'AudioFinished', segmentId: 'poi-high:en' }, NOW + 5000);

    // Try to fire poi-mid — should be no-op because it was skipped (consumed)
    result = reduce(result.state, { kind: 'GeofenceDwell', poiId: 'poi-mid' }, NOW + 6000);
    const active = result.state as ActiveState;
    expect(active.session.playing).toBeUndefined();
    expect(result.commands).toHaveLength(0);
  });

  it('priority resolution works from Standby state (Req 7.3)', () => {
    const standbyState: StandbyState = {
      phase: 'Standby',
      session: makeSession({
        geofences: OVERLAPPING_GEOFENCES,
        lastAccepted: makeAcceptedUpdate({ coord: OVERLAP_CENTER, smoothed: OVERLAP_CENTER }),
      }),
      standbyTrackId: 'trivia-architecture',
    };

    const result = reduce(standbyState, { kind: 'GeofenceDwell', poiId: 'poi-low' }, NOW);

    expect(result.state.phase).toBe('Active');
    const active = result.state as ActiveState;
    expect(active.session.playing!.poiId).toBe('poi-high');
    expect(active.session.consumed.has('poi-mid')).toBe(true);
    expect(active.session.consumed.has('poi-low')).toBe(true);
    expect(result.commands).toContainEqual({ kind: 'StopAudio' });
    expect(result.commands).toContainEqual(
      expect.objectContaining({ kind: 'PlaySegment', segmentId: 'poi-high:en' }),
    );
  });
});
