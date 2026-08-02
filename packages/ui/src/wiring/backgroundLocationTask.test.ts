// backgroundLocationTask.test.ts — tests for BUG 3 (orphan self-heal) and BUG 5 (consumed advance).

jest.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (fn: () => void) => fn(),
  },
  Platform: { OS: 'ios', Version: '17.0' },
  PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
}));

// Track calls through a shared mutable object (survives jest.mock hoisting).
const locationMockState = {
  hasStarted: false,
  stopCalls: 0,
  hasStartedCalls: 0,
};

jest.mock('expo-location', () => ({
  hasStartedLocationUpdatesAsync: () => {
    locationMockState.hasStartedCalls++;
    return Promise.resolve(locationMockState.hasStarted);
  },
  stopLocationUpdatesAsync: () => {
    locationMockState.stopCalls++;
    locationMockState.hasStarted = false;
    return Promise.resolve();
  },
  startLocationUpdatesAsync: () => {
    locationMockState.hasStarted = true;
    return Promise.resolve();
  },
  Accuracy: { Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2, OtherNavigation: 5 },
  PermissionStatus: { GRANTED: 'granted' },
}));

type TaskCallback = (body: {
  data: { locations: Array<Record<string, unknown>> } | null;
  error: unknown;
}) => Promise<void>;
let registeredTask: TaskCallback | null = null;

jest.mock('expo-task-manager', () => ({
  isTaskDefined: () => false,
  defineTask: (_name: string, cb: TaskCallback) => {
    registeredTask = cb;
  },
}));

jest.mock('./androidPermissions', () => ({
  ensureAndroidPostNotificationsPermission: () => Promise.resolve(true),
}));

// Import AFTER mocks — the module-level `ensureLocationTaskDefined()` will run.
import {
  bindLocationSession,
  unbindLocationSession,
  ingestLocationFix,
} from './backgroundLocationTask';
import type { LocationAdapterEvents } from './backgroundLocationTask';
import type { LocationObject } from 'expo-location';

function makeLoc(lat: number, lon: number, accuracy = 10, ts = Date.now()): LocationObject {
  return {
    timestamp: ts,
    coords: {
      latitude: lat,
      longitude: lon,
      accuracy,
      speed: 5,
      heading: 90,
      altitude: 100,
      altitudeAccuracy: 10,
    },
  } as LocationObject;
}

/** Flush microtask queue to let fire-and-forget promises settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('backgroundLocationTask — BUG 3: orphan self-heal', () => {
  beforeEach(() => {
    locationMockState.hasStarted = true;
    locationMockState.stopCalls = 0;
    locationMockState.hasStartedCalls = 0;
    unbindLocationSession();
  });

  it('stops background updates when the task fires with no session', async () => {
    expect(registeredTask).not.toBeNull();

    await registeredTask!({
      data: { locations: [makeLoc(52.0, 21.0)] as unknown as Array<Record<string, unknown>> },
      error: null,
    });

    // The stop is fire-and-forget inside the callback — flush promises.
    await flushPromises();

    expect(locationMockState.hasStartedCalls).toBeGreaterThan(0);
    expect(locationMockState.stopCalls).toBe(1);
  });

  it('only attempts the stop once per cold start (no stop-storm)', async () => {
    // Bind and unbind to reset the orphanStopAttempted flag.
    const events: LocationAdapterEvents = {
      onAccepted: () => {},
      onGeofenceDwell: () => {},
      onPermissionDenied: () => {},
    };
    bindLocationSession([[52, 21]], [], events, () => true);
    unbindLocationSession();

    locationMockState.stopCalls = 0;
    locationMockState.hasStarted = true;

    await registeredTask!({ data: { locations: [] }, error: null });
    await flushPromises();
    await registeredTask!({ data: { locations: [] }, error: null });
    await flushPromises();
    await registeredTask!({ data: { locations: [] }, error: null });
    await flushPromises();

    expect(locationMockState.stopCalls).toBe(1);
  });
});

describe('backgroundLocationTask — BUG 5: consumed set advance', () => {
  let firedPois: string[];

  beforeEach(() => {
    firedPois = [];
  });

  it('does not re-fire a consumed POI on subsequent fixes', () => {
    const route: [number, number][] = [
      [52.0, 21.0],
      [52.1, 21.1],
    ];
    const geofences = [
      {
        poiId: 'poi-a',
        geometry: {
          kind: 'circle' as const,
          center: [52.0, 21.0] as [number, number],
          radiusMeters: 200,
        },
        dwellSec: 0,
        priority: 1,
        authorIndex: 0,
      },
    ];

    const events: LocationAdapterEvents = {
      onAccepted: () => {},
      onGeofenceDwell: (poiId) => firedPois.push(poiId),
      onPermissionDenied: () => {},
    };

    bindLocationSession(route, geofences, events, () => true);

    const ts = Date.now();
    // First fix inside the geofence — should fire.
    ingestLocationFix(makeLoc(52.0, 21.0, 10, ts));
    expect(firedPois).toEqual(['poi-a']);

    // Second fix still inside — should NOT re-fire.
    ingestLocationFix(makeLoc(52.0, 21.0, 10, ts + 1000));
    expect(firedPois).toEqual(['poi-a']);
  });
});
