// TourRuntime.test.ts — tests for the command translator / wiring layer.
//
// Covers:
//   - BUG 2: deliberate vs OS-interrupted stops
//   - Public contract: replayLastSegment, backgroundStatus, lastFixAtMs

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock AppState from react-native (shared mock may not include it).
const mockAppStateListeners: Array<(state: string) => void> = [];

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (event: string, handler: (state: string) => void) => {
      if (event === 'change') mockAppStateListeners.push(handler);
      return {
        remove: () => {
          const idx = mockAppStateListeners.indexOf(handler);
          if (idx >= 0) mockAppStateListeners.splice(idx, 1);
        },
      };
    },
  },
  InteractionManager: {
    runAfterInteractions: (fn: () => void) => fn(),
  },
  Platform: { OS: 'ios', Version: '17.0' },
  PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
}));

// Speech mock with controllable callbacks — use object so hoisting works.
const speechMock = {
  callbacks: {} as {
    onStart?: () => void;
    onDone?: () => void;
    onStopped?: () => void;
    onError?: () => void;
  },
  speakCalls: [] as Array<{ text: string; opts: Record<string, unknown> }>,
  /** Voices reported by getAvailableVoicesAsync. Empty ⇒ no TTS engine. */
  voices: [{ identifier: 'v1', name: 'Voice', quality: 'Default', language: 'en-US' }] as Array<{
    identifier: string;
    name: string;
    quality: string;
    language: string;
  }>,
  /** When false, speak() never fires onStart — simulates a missing TTS engine. */
  autoStart: true,
};

jest.mock('expo-speech', () => ({
  speak: (text: string, opts?: Record<string, unknown>) => {
    speechMock.speakCalls.push({ text, opts: opts ?? {} });
    const onStart = opts?.onStart as (() => void) | undefined;
    const onDone = opts?.onDone as (() => void) | undefined;
    const onStopped = opts?.onStopped as (() => void) | undefined;
    const onError = opts?.onError as (() => void) | undefined;
    speechMock.callbacks = {
      ...(onStart ? { onStart } : {}),
      ...(onDone ? { onDone } : {}),
      ...(onStopped ? { onStopped } : {}),
      ...(onError ? { onError } : {}),
    };
    if (speechMock.autoStart) onStart?.();
  },
  stop: () => Promise.resolve(),
  getAvailableVoicesAsync: () => Promise.resolve(speechMock.voices),
}));

jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve(),
}));

jest.mock('./audioSession', () => ({
  configureTourAudioSession: () => Promise.resolve(),
  releaseTourAudioSession: () => Promise.resolve(),
}));

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: () => Promise.resolve({ status: 'granted' }),
  requestBackgroundPermissionsAsync: () => Promise.resolve({ status: 'granted' }),
  getBackgroundPermissionsAsync: () => Promise.resolve({ status: 'denied' }),
  watchPositionAsync: () => Promise.resolve({ remove: () => {} }),
  hasStartedLocationUpdatesAsync: () => Promise.resolve(false),
  startLocationUpdatesAsync: () => Promise.resolve(),
  stopLocationUpdatesAsync: () => Promise.resolve(),
  Accuracy: { Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2, OtherNavigation: 5 },
  PermissionStatus: { GRANTED: 'granted' },
}));

jest.mock('expo-task-manager', () => ({
  isTaskDefined: () => true,
  defineTask: () => {},
}));

import { TourRuntime } from './TourRuntime';
import type { StartTourConfig } from '../../../engine/src';

const MINIMAL_CONFIG: StartTourConfig = {
  bundle: { bundleId: 'test', bundleVersion: '1.0.0' },
  geofences: [],
  route: [[52.0, 21.0]],
  language: 'en',
};

describe('TourRuntime — BUG 2: deliberate-stop tracking', () => {
  let runtime: TourRuntime;

  beforeEach(() => {
    speechMock.callbacks = {};
    speechMock.speakCalls = [];
    mockAppStateListeners.length = 0;
    runtime = new TourRuntime({ narrativeResolver: () => 'Hello world' });
  });

  afterEach(() => {
    runtime.destroy();
  });

  it('onDone dispatches AudioFinished and marks the POI consumed', () => {
    runtime.start(MINIMAL_CONFIG);
    // Simulate a GeofenceDwell to trigger PlaySegment via the reducer.
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-1' });

    // Verify the segment is playing.
    const state = runtime.getState();
    expect(state.phase).not.toBe('Idle');
    if (state.phase === 'Active') {
      expect(state.session.playing).toBeDefined();
    }

    // Simulate natural completion.
    speechMock.callbacks.onDone?.();

    const after = runtime.getState();
    if (after.phase === 'Active') {
      expect(after.session.consumed.has('poi-1')).toBe(true);
      expect(after.session.playing).toBeUndefined();
    }
  });

  it('non-deliberate onStopped dispatches FocusLoss, NOT AudioFinished', () => {
    runtime.start(MINIMAL_CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-2' });

    // State should have a playing segment.
    const before = runtime.getState();
    if (before.phase === 'Active') {
      expect(before.session.playing).toBeDefined();
    }

    // Simulate an OS-level interruption (phone call, Siri).
    // The onStopped fires WITHOUT deliberateStop being set.
    speechMock.callbacks.onStopped?.();

    // After FocusLoss: the POI should NOT be consumed.
    const after = runtime.getState();
    if (after.phase === 'Active') {
      expect(after.session.consumed.has('poi-2')).toBe(false);
      // playing may still be set (FocusLoss leaves it for resume).
      expect(after.session.focusLostAtMs).toBeDefined();
    }
  });

  it('onError dispatches AudioFinished (unspeakable text advances)', () => {
    runtime.start(MINIMAL_CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-3' });

    speechMock.callbacks.onError?.();

    const after = runtime.getState();
    if (after.phase === 'Active') {
      expect(after.session.consumed.has('poi-3')).toBe(true);
    }
  });

  it('FocusRegain dispatches when app returns to foreground after focus loss', () => {
    runtime.start(MINIMAL_CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-4' });

    // Simulate OS interruption.
    speechMock.callbacks.onStopped?.();

    const stateFocusLost = runtime.getState();
    if (stateFocusLost.phase === 'Active') {
      expect(stateFocusLost.session.focusLostAtMs).toBeDefined();
    }

    // Simulate app returning to foreground.
    for (const handler of mockAppStateListeners) handler('active');

    // After FocusRegain the reducer clears focusLostAtMs.
    const stateRegained = runtime.getState();
    if (stateRegained.phase === 'Active') {
      expect(stateRegained.session.focusLostAtMs).toBeUndefined();
    }
  });
});

describe('TourRuntime — public contract', () => {
  let runtime: TourRuntime;

  beforeEach(() => {
    speechMock.callbacks = {};
    speechMock.speakCalls = [];
    mockAppStateListeners.length = 0;
    runtime = new TourRuntime({ narrativeResolver: () => 'Test narration text' });
  });

  afterEach(() => {
    runtime.destroy();
  });

  it('replayLastSegment is a no-op when nothing has played', () => {
    speechMock.speakCalls = [];
    runtime.replayLastSegment();
    // speak should not be called for replay
    expect(speechMock.speakCalls).toHaveLength(0);
  });

  it('replayLastSegment re-speaks after a segment has played', () => {
    runtime.start(MINIMAL_CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-replay' });
    speechMock.speakCalls = [];

    runtime.replayLastSegment();
    expect(speechMock.speakCalls).toHaveLength(1);
    expect(speechMock.speakCalls[0]!.text).toBe('Test narration text');
    expect(speechMock.speakCalls[0]!.opts).toMatchObject({ language: 'en' });
  });

  it('getBackgroundStatus returns foreground-only initially', () => {
    expect(runtime.getBackgroundStatus()).toEqual({
      mode: 'foreground-only',
      reason: 'unavailable',
    });
  });

  it('getLastFixAtMs returns null initially', () => {
    expect(runtime.getLastFixAtMs()).toBeNull();
  });
});

// ─── Wave 0 regressions: the two tour-killers ─────────────────────────────

describe('TourRuntime — Replay must not strand the engine', () => {
  beforeEach(() => {
    speechMock.callbacks = {};
    speechMock.speakCalls = [];
    speechMock.autoStart = true;
    speechMock.voices = [
      { identifier: 'v1', name: 'Voice', quality: 'Default', language: 'en-US' },
    ];
    mockAppStateListeners.length = 0;
  });

  // REGRESSION: replayLastSegment used to always speak WITHOUT engine
  // callbacks. Tapping Replay mid-narration swallowed the pre-emptive stop as
  // deliberate, so AudioFinished never fired, session.playing stayed set
  // forever, and the single-segment invariant suppressed every remaining POI
  // for the rest of the ride. One tap killed the tour.
  it('replaying mid-narration still lets the next POI fire', () => {
    const runtime = new TourRuntime({ narrativeResolver: () => 'Narration' });
    runtime.start(MINIMAL_CONFIG);

    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-a' });
    const playing = runtime.getState();
    if (playing.phase === 'Active') {
      expect(playing.session.playing?.poiId).toBe('poi-a');
    }

    // Rider taps Replay while poi-a is still being spoken.
    runtime.replayLastSegment();

    // The replayed utterance completes normally.
    speechMock.callbacks.onDone?.();

    const afterReplay = runtime.getState();
    if (afterReplay.phase === 'Active') {
      // Engine is no longer stranded.
      expect(afterReplay.session.playing).toBeUndefined();
      expect(afterReplay.session.consumed.has('poi-a')).toBe(true);
    }

    // And the tour continues: the next POI can still fire.
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-b' });
    const next = runtime.getState();
    if (next.phase === 'Active') {
      expect(next.session.playing?.poiId).toBe('poi-b');
    }

    runtime.destroy();
  });

  it('replaying an already-consumed segment does not touch engine state', () => {
    const runtime = new TourRuntime({ narrativeResolver: () => 'Narration' });
    runtime.start(MINIMAL_CONFIG);

    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-c' });
    speechMock.callbacks.onDone?.();

    const consumed = runtime.getState();
    if (consumed.phase === 'Active') {
      expect(consumed.session.playing).toBeUndefined();
    }

    // Pure-UI replay of a finished segment.
    runtime.replayLastSegment();
    speechMock.callbacks.onDone?.();

    const after = runtime.getState();
    if (after.phase === 'Active') {
      expect(after.session.playing).toBeUndefined();
      expect(after.session.consumed.has('poi-c')).toBe(true);
    }

    runtime.destroy();
  });
});

describe('TourRuntime — missing TTS engine must not hang the tour', () => {
  beforeEach(() => {
    speechMock.callbacks = {};
    speechMock.speakCalls = [];
    mockAppStateListeners.length = 0;
  });

  afterEach(() => {
    speechMock.autoStart = true;
    speechMock.voices = [
      { identifier: 'v1', name: 'Voice', quality: 'Default', language: 'en-US' },
    ];
    jest.useRealTimers();
  });

  // A device with no TTS engine installed makes Speech.speak() a silent
  // no-op: no onStart, onDone, onStopped or onError. Without a watchdog the
  // reducer never clears session.playing and the tour dies on POI #1.
  it('watchdogs a silent speak() so the tour still advances', () => {
    jest.useFakeTimers();
    speechMock.autoStart = false;
    speechMock.voices = [];

    const runtime = new TourRuntime({ narrativeResolver: () => 'Narration' });
    runtime.start(MINIMAL_CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-silent' });

    // Speech was requested but never started.
    expect(speechMock.speakCalls).toHaveLength(1);

    // Watchdog window elapses.
    jest.advanceTimersByTime(4001);

    const after = runtime.getState();
    if (after.phase === 'Active') {
      expect(after.session.playing).toBeUndefined();
      expect(after.session.consumed.has('poi-silent')).toBe(true);
    }
    expect(runtime.getSpeechStatus()).toEqual({ available: false, reason: 'no-engine' });

    // The tour is still usable — the next POI fires.
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-after' });
    const next = runtime.getState();
    if (next.phase === 'Active') {
      expect(next.session.playing?.poiId).toBe('poi-after');
    }

    runtime.destroy();
  });

  it('reports no-engine when the device exposes zero voices', async () => {
    speechMock.voices = [];
    const runtime = new TourRuntime({ narrativeResolver: () => 'Narration' });
    runtime.start(MINIMAL_CONFIG);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getSpeechStatus()).toEqual({ available: false, reason: 'no-engine' });
    runtime.destroy();
  });

  it('reports no-voice-for-language when no voice matches the tour language', async () => {
    speechMock.voices = [
      { identifier: 'pl', name: 'Polish', quality: 'Default', language: 'pl-PL' },
    ];
    const runtime = new TourRuntime({ narrativeResolver: () => 'Narration' });
    runtime.start(MINIMAL_CONFIG); // language: 'en'

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getSpeechStatus()).toEqual({
      available: false,
      reason: 'no-voice-for-language',
    });
    runtime.destroy();
  });

  it('reports available when a matching voice exists', async () => {
    speechMock.voices = [
      { identifier: 'en', name: 'English', quality: 'Default', language: 'en-GB' },
    ];
    const runtime = new TourRuntime({ narrativeResolver: () => 'Narration' });
    runtime.start(MINIMAL_CONFIG);

    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.getSpeechStatus()).toEqual({ available: true });
    runtime.destroy();
  });
});

describe('TourRuntime — debugTriggerNextPoi', () => {
  let runtime: TourRuntime;

  const TWO_POI_CONFIG: StartTourConfig = {
    bundle: { bundleId: 'test', bundleVersion: '1.0.0' },
    language: 'en',
    route: [
      [52.0, 21.0],
      [52.01, 21.0],
    ],
    geofences: [
      {
        poiId: 'poi-a',
        geometry: { kind: 'circle', center: [52.0, 21.0], radiusMeters: 100 },
        dwellSec: 3,
        priority: 50,
        authorIndex: 0,
      },
      {
        poiId: 'poi-b',
        geometry: { kind: 'circle', center: [52.01, 21.0], radiusMeters: 100 },
        dwellSec: 3,
        priority: 50,
        authorIndex: 1,
      },
    ],
  };

  beforeEach(() => {
    speechMock.callbacks = {};
    speechMock.speakCalls = [];
    speechMock.autoStart = true;
    mockAppStateListeners.length = 0;
    runtime = new TourRuntime({ narrativeResolver: () => 'Hello world' });
  });

  afterEach(() => {
    runtime.destroy();
  });

  it('finishes the playing segment and starts the next POI immediately', () => {
    runtime.start(TWO_POI_CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-a' });

    const mid = runtime.getState();
    if (mid.phase === 'Active') {
      expect(mid.session.playing?.poiId).toBe('poi-a');
    }

    runtime.debugTriggerNextPoi();

    const after = runtime.getState();
    if (after.phase === 'Active') {
      expect(after.session.consumed.has('poi-a')).toBe(true);
      expect(after.session.playing?.poiId).toBe('poi-b');
    }
  });
});
