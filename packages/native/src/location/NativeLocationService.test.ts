/**
 * Unit tests for the Location_Service TS-side facade (task 8.1).
 *
 * These tests exercise the JS half of the turbo module surface without
 * standing up React Native's bridge:
 *
 *   - `react-native` is mocked at the module level so
 *     `TurboModuleRegistry.getEnforcing` returns a fake `Spec`.
 *   - The fake `Spec` records every call so we can assert that the
 *     wrapper translates engine-side `Geofence` and `LocationMode`
 *     values into the wire format the native side expects.
 *   - `NativeEventEmitter` is replaced with an in-process emitter so
 *     subscribe / emit can be driven deterministically.
 *
 * Native-side responsibilities (accuracy gate, spike rejection,
 * sliding region window) are covered by instrumented device tests in
 * task 8.7. These unit tests stay above the bridge.
 *
 * Validates: Requirements 5.1, 5.2, 11.1, 11.2, 11.3, 11.4, 11.5,
 *            12.2, 12.3, 15.1.
 */

// ---------------------------------------------------------------------------
// react-native mock — must be declared BEFORE importing the module under
// test so Jest's module registry hands the test the mocked version.
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

interface FakeSpec {
  setMode: (mode: string) => void;
  armGeofences: (geofences: ReadonlyArray<unknown>) => void;
  disarmAll: () => void;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}

const recordedCalls: RecordedCall[] = [];
const recordedEnforcingNames: string[] = [];

function makeFakeSpec(): FakeSpec {
  return {
    setMode(mode: string): void {
      recordedCalls.push({ method: 'setMode', args: [mode] });
    },
    armGeofences(geofences: ReadonlyArray<unknown>): void {
      recordedCalls.push({ method: 'armGeofences', args: [geofences] });
    },
    disarmAll(): void {
      recordedCalls.push({ method: 'disarmAll', args: [] });
    },
    addListener(eventName: string): void {
      recordedCalls.push({ method: 'addListener', args: [eventName] });
    },
    removeListeners(count: number): void {
      recordedCalls.push({ method: 'removeListeners', args: [count] });
    },
  };
}

let fakeSpec: FakeSpec = makeFakeSpec();

/**
 * In-process stand-in for `NativeEventEmitter`. We model the minimum
 * surface the wrapper actually uses: `addListener(eventName, cb)`
 * returning an object with `remove()`.
 */
class FakeNativeEventEmitter {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  // The wrapper passes the underlying turbo-module instance through to
  // `new NativeEventEmitter(...)`; we accept (and ignore) it because our
  // fake doesn't call addListener/removeListeners on the module.
  constructor(_nativeModule?: unknown) {
    // intentionally empty
  }

  addListener(eventName: string, cb: (payload: unknown) => void): { remove: () => void } {
    let set = this.listeners.get(eventName);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(eventName, set);
    }
    set.add(cb);
    return {
      remove: () => {
        const current = this.listeners.get(eventName);
        if (current !== undefined) {
          current.delete(cb);
        }
      },
    };
  }

  /** Test helper: deliver `payload` to every listener for `eventName`. */
  emit(eventName: string, payload: unknown): void {
    const set = this.listeners.get(eventName);
    if (set === undefined) return;
    for (const cb of set) cb(payload);
  }

  /** Test helper: how many listeners are currently attached to `eventName`. */
  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }
}

let fakeEmitter: FakeNativeEventEmitter | null = null;

function setFakeEmitter(instance: FakeNativeEventEmitter): void {
  fakeEmitter = instance;
}

jest.mock('react-native', () => {
  // Constructor stand-in for `NativeEventEmitter`. We use a real class
  // (rather than `jest.fn().mockImplementation`) so the `new` operator
  // returns an instance with the methods the wrapper actually calls.
  class MockNativeEventEmitter extends FakeNativeEventEmitter {
    constructor(nativeModule?: unknown) {
      super(nativeModule);
      setFakeEmitter(this);
    }
  }

  return {
    TurboModuleRegistry: {
      getEnforcing<T>(name: string): T {
        recordedEnforcingNames.push(name);
        return fakeSpec as unknown as T;
      },
      get<T>(name: string): T | null {
        recordedEnforcingNames.push(name);
        return fakeSpec as unknown as T;
      },
    },
    NativeEventEmitter: MockNativeEventEmitter,
  };
});

// Imports MUST come after `jest.mock` so the mock is in place.
import type { Geofence } from '../../../engine/src';
import {
  __resetEmitterForTests,
  armGeofences,
  disarmAll,
  NATIVE_LOCATION_EVENT_NAMES,
  onAccepted,
  onAccuracyChanged,
  onGeofenceDwell,
  onGeofenceEnter,
  onGeofenceExit,
  onRejected,
  setMode,
  toNativeGeofence,
  TRAMIO_LOCATION_SERVICE_MODULE_NAME,
  type NativeAcceptedPayload,
  type NativeAccuracyChangedPayload,
  type NativeGeofencePayload,
  type NativeRejectedPayload,
} from './index';

beforeEach(() => {
  recordedCalls.length = 0;
  // NOTE: We deliberately do NOT clear `recordedEnforcingNames` because
  // its only writer is the module-load-time import side effect. Clearing
  // it would mask the binding-name assertion below.
  fakeSpec = makeFakeSpec();
  fakeEmitter = null;
  __resetEmitterForTests();
});

// ---------------------------------------------------------------------------
// TurboModuleRegistry binding
// ---------------------------------------------------------------------------

describe('NativeLocationService — module binding', () => {
  it('registers the documented native module name', () => {
    expect(TRAMIO_LOCATION_SERVICE_MODULE_NAME).toBe('TramioLocationService');
    // The module-load-time import side effect calls
    // `TurboModuleRegistry.getEnforcing(...)` exactly once; the test
    // file imports `./index` after `jest.mock('react-native', ...)` so
    // the recorded call is captured here.
    expect(recordedEnforcingNames).toContain('TramioLocationService');
  });

  it('exposes the documented event-name set in the documented order', () => {
    expect(NATIVE_LOCATION_EVENT_NAMES).toEqual([
      'onAccepted',
      'onRejected',
      'onGeofenceEnter',
      'onGeofenceDwell',
      'onGeofenceExit',
      'onAccuracyChanged',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Method translation: setMode / armGeofences / disarmAll
// ---------------------------------------------------------------------------

describe('setMode', () => {
  it.each([['idle'], ['standby'], ['tour-bg'], ['tour-approach'], ['reconcile']] as const)(
    'forwards the LocationMode string %s verbatim',
    (mode) => {
      setMode(mode);
      expect(recordedCalls).toEqual([{ method: 'setMode', args: [mode] }]);
    },
  );
});

describe('armGeofences', () => {
  const circleGeofence: Geofence = {
    poiId: 'poi-rynek',
    geometry: { kind: 'circle', center: [51.11, 17.03], radiusMeters: 60 },
    directionFilter: { kind: 'alongRoute', toleranceDeg: 30 },
    dwellSec: 4,
    priority: 90,
    authorIndex: 0,
  };

  const polygonGeofence: Geofence = {
    poiId: 'poi-park',
    geometry: {
      kind: 'polygon',
      vertices: [
        [51.111, 17.031],
        [51.112, 17.032],
        [51.113, 17.033],
      ],
    },
    dwellSec: 6,
    priority: 50,
    authorIndex: 1,
  };

  it('forwards a single circle geofence as the wire shape', () => {
    armGeofences([circleGeofence]);

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0]?.method).toBe('armGeofences');
    expect(recordedCalls[0]?.args[0]).toEqual([
      {
        poiId: 'poi-rynek',
        geometry: { kind: 'circle', center: [51.11, 17.03], radiusMeters: 60 },
        dwellSec: 4,
      },
    ]);
  });

  it('forwards a polygon geofence with its full vertex list', () => {
    armGeofences([polygonGeofence]);

    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0]?.args[0]).toEqual([
      {
        poiId: 'poi-park',
        geometry: {
          kind: 'polygon',
          vertices: [
            [51.111, 17.031],
            [51.112, 17.032],
            [51.113, 17.033],
          ],
        },
        dwellSec: 6,
      },
    ]);
  });

  it('preserves the input order across many geofences', () => {
    const fence = (i: number): Geofence => ({
      poiId: `poi-${i}`,
      geometry: { kind: 'circle', center: [51 + i * 0.001, 17], radiusMeters: 50 },
      dwellSec: 3,
      priority: 50,
      authorIndex: i,
    });
    const fences = Array.from({ length: 25 }, (_, i) => fence(i));
    armGeofences(fences);

    const wire = recordedCalls[0]?.args[0] as ReadonlyArray<{ poiId: string }>;
    expect(wire).toHaveLength(25);
    expect(wire.map((g) => g.poiId)).toEqual(fences.map((g) => g.poiId));
  });

  it('drops the engine-side directionFilter from the wire payload', () => {
    // The native side enforces only stages 1 and 2; direction filtering
    // happens in JS. Forwarding `directionFilter` to native would be
    // dead weight on the bridge.
    armGeofences([circleGeofence]);
    const wire = recordedCalls[0]?.args[0] as ReadonlyArray<Record<string, unknown>>;
    expect(wire[0]).not.toHaveProperty('directionFilter');
  });
});

describe('toNativeGeofence', () => {
  it('is a pure mapping for circle geofences', () => {
    const g: Geofence = {
      poiId: 'poi-1',
      geometry: { kind: 'circle', center: [50, 17], radiusMeters: 75 },
      dwellSec: 3,
      priority: 50,
      authorIndex: 0,
    };
    const native = toNativeGeofence(g);
    expect(native).toEqual({
      poiId: 'poi-1',
      geometry: { kind: 'circle', center: [50, 17], radiusMeters: 75 },
      dwellSec: 3,
    });
    // Round-tripping the same input twice produces structurally equal
    // outputs (no shared mutable state).
    expect(toNativeGeofence(g)).toEqual(native);
  });

  it('is a pure mapping for polygon geofences', () => {
    const g: Geofence = {
      poiId: 'poi-poly',
      geometry: {
        kind: 'polygon',
        vertices: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      },
      dwellSec: 5,
      priority: 50,
      authorIndex: 0,
    };
    expect(toNativeGeofence(g)).toEqual({
      poiId: 'poi-poly',
      geometry: {
        kind: 'polygon',
        vertices: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      },
      dwellSec: 5,
    });
  });
});

describe('disarmAll', () => {
  it('forwards the call to the native module with no arguments', () => {
    disarmAll();
    expect(recordedCalls).toEqual([{ method: 'disarmAll', args: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

describe('event subscriptions', () => {
  function emitter(): FakeNativeEventEmitter {
    if (fakeEmitter === null) {
      throw new Error('NativeEventEmitter was not constructed yet');
    }
    return fakeEmitter;
  }

  it('delivers onAccepted payloads to subscribers', () => {
    const seen: NativeAcceptedPayload[] = [];
    const sub = onAccepted((p) => seen.push(p));

    const payload: NativeAcceptedPayload = {
      ts: 1_700_000_000_000,
      coord: [51.11, 17.03],
      accuracyM: 12,
      speedMps: 5,
      headingDeg: 90,
      mode: 'tour-approach',
    };
    emitter().emit('onAccepted', payload);

    expect(seen).toEqual([payload]);
    sub.remove();
    emitter().emit('onAccepted', payload);
    expect(seen).toHaveLength(1);
  });

  it('delivers onRejected payloads with the documented reasons', () => {
    const seen: NativeRejectedPayload[] = [];
    onRejected((p) => seen.push(p));

    const accuracyMiss: NativeRejectedPayload = {
      reason: 'accuracy',
      ts: 1,
      coord: [0, 0],
      accuracyM: 75,
    };
    const spike: NativeRejectedPayload = {
      reason: 'spike',
      ts: 2,
      coord: [0.001, 0],
      accuracyM: 10,
    };
    const dup: NativeRejectedPayload = {
      reason: 'duplicate',
      ts: 3,
      coord: [0, 0],
      accuracyM: 10,
    };
    emitter().emit('onRejected', accuracyMiss);
    emitter().emit('onRejected', spike);
    emitter().emit('onRejected', dup);

    expect(seen.map((p) => p.reason)).toEqual(['accuracy', 'spike', 'duplicate']);
  });

  it('delivers each geofence lifecycle event to its dedicated subscriber', () => {
    const enter: NativeGeofencePayload[] = [];
    const dwell: NativeGeofencePayload[] = [];
    const exit: NativeGeofencePayload[] = [];

    onGeofenceEnter((p) => enter.push(p));
    onGeofenceDwell((p) => dwell.push(p));
    onGeofenceExit((p) => exit.push(p));

    emitter().emit('onGeofenceEnter', { poiId: 'poi-1', ts: 100 });
    emitter().emit('onGeofenceDwell', { poiId: 'poi-1', ts: 200 });
    emitter().emit('onGeofenceExit', { poiId: 'poi-1', ts: 300 });

    expect(enter).toEqual([{ poiId: 'poi-1', ts: 100 }]);
    expect(dwell).toEqual([{ poiId: 'poi-1', ts: 200 }]);
    expect(exit).toEqual([{ poiId: 'poi-1', ts: 300 }]);
  });

  it('delivers onAccuracyChanged so the UI can drive the high-accuracy indicator', () => {
    // Validates Req 11.5: the user-visible high-accuracy indicator is
    // bound to the engine's mode transitions in / out of `tour-approach`
    // / `reconcile`.
    const seen: NativeAccuracyChangedPayload[] = [];
    onAccuracyChanged((p) => seen.push(p));

    emitter().emit('onAccuracyChanged', { highAccuracy: true, mode: 'tour-approach' });
    emitter().emit('onAccuracyChanged', { highAccuracy: false, mode: 'tour-bg' });

    expect(seen).toEqual([
      { highAccuracy: true, mode: 'tour-approach' },
      { highAccuracy: false, mode: 'tour-bg' },
    ]);
  });

  it('detaches listeners cleanly after .remove()', () => {
    const subA = onAccepted(() => {});
    const subB = onAccepted(() => {});
    expect(emitter().listenerCount('onAccepted')).toBe(2);

    subA.remove();
    expect(emitter().listenerCount('onAccepted')).toBe(1);

    subB.remove();
    expect(emitter().listenerCount('onAccepted')).toBe(0);
  });
});
