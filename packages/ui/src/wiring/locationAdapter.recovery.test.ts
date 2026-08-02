// locationAdapter.recovery.test.ts — Wave 4: GPS delivery stall watchdog + recovery tests.
//
// Uses fake timers and injectable clock for deterministic testing.

jest.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (fn: () => void) => fn(),
  },
  Platform: { OS: 'ios', Version: '17.0' },
  PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
}));

// Track watch subscriptions.
const watchState = {
  watchCallbacks: [] as Array<(loc: any) => void>,
  watchRemoves: [] as jest.Mock[],
  permissionStatus: 'granted',
  bgPermissionStatus: 'denied',
  watchError: false,
  backgroundStartError: false,
};

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: () => Promise.resolve({ status: watchState.permissionStatus }),
  requestBackgroundPermissionsAsync: () =>
    Promise.resolve({ status: watchState.bgPermissionStatus }),
  getBackgroundPermissionsAsync: () => Promise.resolve({ status: watchState.bgPermissionStatus }),
  watchPositionAsync: (_opts: unknown, callback: (loc: any) => void) => {
    if (watchState.watchError) {
      return Promise.reject(new Error('Watch failed'));
    }
    watchState.watchCallbacks.push(callback);
    const remove = jest.fn();
    watchState.watchRemoves.push(remove);
    return Promise.resolve({ remove });
  },
  hasStartedLocationUpdatesAsync: () => Promise.resolve(false),
  stopLocationUpdatesAsync: () => Promise.resolve(),
  startLocationUpdatesAsync: () =>
    watchState.backgroundStartError
      ? Promise.reject(new Error('background unavailable'))
      : Promise.resolve(),
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
  defineTask: (_name: string, callback: TaskCallback) => {
    registeredTask = callback;
  },
}));

jest.mock('./androidPermissions', () => ({
  ensureAndroidPostNotificationsPermission: () => Promise.resolve(true),
}));

import {
  LocationAdapter,
  type LocationAdapterExtendedEvents,
  type LocationDeliveryStatus,
  type LocationAdapterClock,
} from './locationAdapter';

interface FakeTimer {
  fn: () => void;
  delay: number;
  id: number;
}

function makeFakeClock(): LocationAdapterClock & {
  advance(ms: number): void;
  now(): number;
  timers: FakeTimer[];
  currentTime: number;
} {
  let currentTime = 0;
  let nextId = 1;
  const timers: FakeTimer[] = [];

  return {
    get currentTime() {
      return currentTime;
    },
    timers,
    now: () => currentTime,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ fn, delay: ms, id });
      return id;
    },
    clearTimeout: (handle: unknown) => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
    advance(ms: number) {
      currentTime += ms;
      // Fire timers that have expired.
      const expired = timers.filter((t) => t.delay <= ms);
      for (const t of expired) {
        const idx = timers.indexOf(t);
        if (idx >= 0) timers.splice(idx, 1);
        t.fn();
      }
      // Reduce delay on remaining timers.
      for (const t of timers) {
        t.delay -= ms;
      }
    },
  };
}

function makeEvents(): LocationAdapterExtendedEvents & {
  deliveredCalls: Array<{ accuracyM: number | null }>;
  rejectedCalls: Array<{ reason: string; accuracyM: number | null }>;
  acceptedCalls: any[];
} {
  const deliveredCalls: Array<{ accuracyM: number | null }> = [];
  const rejectedCalls: Array<{ reason: string; accuracyM: number | null }> = [];
  const acceptedCalls: any[] = [];
  return {
    onAccepted: (update: any) => acceptedCalls.push(update),
    onGeofenceDwell: () => {},
    onPermissionDenied: () => {},
    onDelivered: (meta) => deliveredCalls.push(meta),
    onRejected: (meta) => rejectedCalls.push(meta),
    deliveredCalls,
    rejectedCalls,
    acceptedCalls,
  };
}

function makeLoc(accuracy = 10, lat = 52.0, lon = 21.0) {
  return {
    timestamp: Date.now(),
    coords: {
      latitude: lat,
      longitude: lon,
      accuracy,
      speed: 5,
      heading: 90,
      altitude: 100,
      altitudeAccuracy: 10,
    },
  };
}

describe('LocationAdapter — Wave 4: Watchdog & Recovery', () => {
  beforeEach(() => {
    watchState.watchCallbacks = [];
    watchState.watchRemoves = [];
    watchState.permissionStatus = 'granted';
    watchState.bgPermissionStatus = 'denied';
    watchState.watchError = false;
    watchState.backgroundStartError = false;
  });

  it('starts in acquiring status', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      { clock },
    );

    expect(adapter.getDeliveryStatus()).toBe('acquiring');
  });

  it('transitions to live on first raw delivery', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      { clock },
    );

    await adapter.start();

    const statusChanges: LocationDeliveryStatus[] = [];
    adapter.subscribeDeliveryStatus((s) => statusChanges.push(s));

    // Simulate a raw GPS callback.
    const watchCb = watchState.watchCallbacks[0]!;
    watchCb(makeLoc(10));

    expect(adapter.getDeliveryStatus()).toBe('live');
    expect(statusChanges).toContain('live');
  });

  it('triggers recovery when no callback within stall threshold', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    let recoveryAttempts = 0;
    adapter.onRecoveryAttempt = () => recoveryAttempts++;

    await adapter.start();

    // No callback arrives — advance past the stall threshold.
    clock.advance(5000);

    // Should have attempted recovery.
    expect(recoveryAttempts).toBe(1);
    expect(adapter.getDeliveryStatus()).toBe('recovering');
  });

  it('rejected callback prevents false stall (resets watchdog)', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    let recoveryAttempts = 0;
    adapter.onRecoveryAttempt = () => recoveryAttempts++;

    await adapter.start();

    // Deliver a fix with poor accuracy at 4s (before stall threshold).
    clock.advance(4000);
    const watchCb = watchState.watchCallbacks[0]!;
    watchCb(makeLoc(100)); // Will be rejected by pipeline for accuracy

    // Advance another 4s (total 8s from start, but only 4s since last delivery).
    clock.advance(4000);

    // Should NOT have triggered recovery because the watchdog was reset.
    expect(recoveryAttempts).toBe(0);
    expect(adapter.getDeliveryStatus()).toBe('live');
  });

  it('accepted callback resets watchdog and status', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    await adapter.start();

    // Deliver a good-accuracy fix.
    const watchCb = watchState.watchCallbacks[0]!;
    watchCb(makeLoc(10));

    expect(adapter.getDeliveryStatus()).toBe('live');

    // Advance up to (but not through) the new threshold.
    clock.advance(4999);
    expect(adapter.getDeliveryStatus()).toBe('live');
  });

  it('ignores a stale callback from the foreground watch removed during recovery', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    await adapter.start();
    const staleCallback = watchState.watchCallbacks[0]!;

    clock.advance(5000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getDeliveryStatus()).toBe('stalled');

    staleCallback(makeLoc(10));
    expect(adapter.getDeliveryStatus()).toBe('stalled');
    expect(events.deliveredCalls).toHaveLength(0);

    const replacementCallback = watchState.watchCallbacks.at(-1)!;
    replacementCallback(makeLoc(10));
    expect(adapter.getDeliveryStatus()).toBe('live');
    expect(events.deliveredCalls).toHaveLength(1);
  });

  it('foreground restart: removes old watch and creates new one', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    await adapter.start();
    const initialWatchCount = watchState.watchCallbacks.length;
    const initialRemove = watchState.watchRemoves[0]!;

    // Trigger stall.
    clock.advance(5000);

    // Wait for async recovery to complete.
    await new Promise((r) => setTimeout(r, 0));

    // Old watch should be removed.
    expect(initialRemove).toHaveBeenCalled();
    // New watch should be created.
    expect(watchState.watchCallbacks.length).toBe(initialWatchCount + 1);
  });

  it('background restart remains stalled until a fresh task callback arrives', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    watchState.bgPermissionStatus = 'granted';

    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    await adapter.start();
    expect(adapter.getActiveChannel()).toBe('background');

    let recoverySuccesses = 0;
    adapter.onRecoverySuccess = () => recoverySuccesses++;

    clock.advance(5000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recoverySuccesses).toBe(0);
    expect(adapter.getDeliveryStatus()).toBe('stalled');

    await registeredTask!({
      data: { locations: [makeLoc(10)] },
      error: null,
    });

    expect(recoverySuccesses).toBe(1);
    expect(adapter.getDeliveryStatus()).toBe('live');
  });

  it('healthy rejected background callbacks reset the watchdog without restart', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    watchState.bgPermissionStatus = 'granted';

    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );
    let recoveryAttempts = 0;
    adapter.onRecoveryAttempt = () => recoveryAttempts++;

    await adapter.start();
    clock.advance(4000);
    await registeredTask!({
      data: { locations: [makeLoc(100)] },
      error: null,
    });
    clock.advance(4000);

    expect(events.rejectedCalls).toHaveLength(1);
    expect(recoveryAttempts).toBe(0);
    expect(adapter.getDeliveryStatus()).toBe('live');
  });

  it('background restart failure falls back to foreground', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    watchState.bgPermissionStatus = 'granted';

    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    await adapter.start();
    expect(adapter.getActiveChannel()).toBe('background');

    let failureCount = 0;
    adapter.onRecoveryFailure = () => failureCount++;

    // Make background restart fail.
    watchState.backgroundStartError = true;

    // Trigger stall.
    clock.advance(5000);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(failureCount).toBe(1);
    expect(adapter.getActiveChannel()).toBe('foreground');

    watchState.backgroundStartError = false;
  });

  it('repeated stalls use bounded backoff', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 1000, maxBackoffMs: 4000, backoffMultiplier: 2 },
      },
    );

    let recoveryAttempts = 0;
    adapter.onRecoveryAttempt = () => recoveryAttempts++;

    await adapter.start();

    // First stall at 1000ms.
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(1);

    // After first recovery without new callback, status is stalled.
    // Next timer should be 2000ms (1000 * 2).
    clock.advance(2000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(2);

    // Next should be 4000ms (2000 * 2, capped at 4000).
    clock.advance(4000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(3);

    // Should stay at cap.
    clock.advance(4000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(4);
  });

  it('stop() suppresses pending and in-flight recovery', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 5000 },
      },
    );

    let recoveryAttempts = 0;
    adapter.onRecoveryAttempt = () => recoveryAttempts++;

    await adapter.start();

    // Stop before stall fires.
    adapter.stop();

    // Advance past threshold — should NOT trigger recovery.
    clock.advance(10000);

    expect(recoveryAttempts).toBe(0);
  });

  it('stop() during active recovery prevents watch re-creation', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 1000 },
      },
    );

    await adapter.start();
    const initialWatchCount = watchState.watchCallbacks.length;

    // Trigger stall, then immediately stop.
    clock.advance(1000);
    adapter.stop();

    await new Promise((r) => setTimeout(r, 0));

    // Any watch created before stop resolves must be removed immediately.
    for (let i = initialWatchCount; i < watchState.watchRemoves.length; i++) {
      expect(watchState.watchRemoves[i]).toHaveBeenCalled();
    }
  });

  it('delivery resets backoff', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 1000, maxBackoffMs: 8000, backoffMultiplier: 2 },
      },
    );

    let recoveryAttempts = 0;
    adapter.onRecoveryAttempt = () => recoveryAttempts++;

    await adapter.start();

    // First stall.
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(1);

    // Second stall (backoff 2000).
    clock.advance(2000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(2);

    // Now deliver a callback — should reset backoff.
    const latestCb = watchState.watchCallbacks[watchState.watchCallbacks.length - 1]!;
    latestCb(makeLoc(10));

    // Next stall should be at base threshold again (1000ms).
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(3);
  });

  it('exposes capped recovery count', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 100, maxBackoffMs: 100, maxRecoveryCountForUI: 3 },
      },
    );

    await adapter.start();

    for (let i = 0; i < 5; i++) {
      clock.advance(100);
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(adapter.getRecoveryCount()).toBe(3); // Capped at 3.
  });

  it('requestImmediateRecovery works when stalled', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      {
        clock,
        recovery: { stallThresholdMs: 1000, maxBackoffMs: 10000, backoffMultiplier: 10 },
      },
    );

    let recoveryAttempts = 0;
    adapter.onRecoveryAttempt = () => recoveryAttempts++;

    await adapter.start();

    // First stall.
    clock.advance(1000);
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(1);

    // Now in stalled, next auto-recovery would be at 10000ms.
    // Request immediate recovery.
    adapter.requestImmediateRecovery();
    await new Promise((r) => setTimeout(r, 0));
    expect(recoveryAttempts).toBe(2);
  });

  it('onDelivered is called with privacy-safe metadata', async () => {
    const clock = makeFakeClock();
    const events = makeEvents();
    const adapter = new LocationAdapter(
      [
        [52, 21],
        [52.01, 21.01],
      ],
      [],
      events,
      { clock },
    );

    await adapter.start();
    const watchCb = watchState.watchCallbacks[0]!;
    watchCb(makeLoc(15));

    expect(events.deliveredCalls.length).toBe(1);
    expect(events.deliveredCalls[0]!.accuracyM).toBe(15);
    expect(events.deliveredCalls[0]).not.toHaveProperty('timestamp');
    // No coordinates in the delivered metadata.
    expect(events.deliveredCalls[0]).not.toHaveProperty('coord');
    expect(events.deliveredCalls[0]).not.toHaveProperty('latitude');
    expect(events.deliveredCalls[0]).not.toHaveProperty('longitude');
  });
});
