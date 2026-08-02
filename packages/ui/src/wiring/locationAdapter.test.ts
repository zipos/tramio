// locationAdapter.test.ts — tests for BUG 4 (async cancellation leaks).

jest.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (fn: () => void) => fn(),
  },
  Platform: { OS: 'ios', Version: '17.0' },
  PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
}));

// Shared mutable state for the expo-location mock.
const locationState = {
  permissionResolve: null as ((v: { status: string }) => void) | null,
  watchResolve: null as ((v: { remove: () => void }) => void) | null,
  watchRemoveCalled: false,
};

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: () =>
    new Promise((resolve) => {
      locationState.permissionResolve = resolve;
    }),
  requestBackgroundPermissionsAsync: () => Promise.resolve({ status: 'denied' }),
  getBackgroundPermissionsAsync: () => Promise.resolve({ status: 'denied' }),
  watchPositionAsync: () =>
    new Promise((resolve) => {
      locationState.watchResolve = resolve;
    }),
  hasStartedLocationUpdatesAsync: () => Promise.resolve(false),
  stopLocationUpdatesAsync: () => Promise.resolve(),
  startLocationUpdatesAsync: () => Promise.resolve(),
  Accuracy: { Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2, OtherNavigation: 5 },
  PermissionStatus: { GRANTED: 'granted' },
}));

jest.mock('expo-task-manager', () => ({
  isTaskDefined: () => true,
  defineTask: () => {},
}));

jest.mock('./androidPermissions', () => ({
  ensureAndroidPostNotificationsPermission: () => Promise.resolve(true),
}));

import { LocationAdapter, type LocationAdapterEvents } from './locationAdapter';

function makeEvents(): LocationAdapterEvents {
  return {
    onAccepted: () => {},
    onGeofenceDwell: () => {},
    onPermissionDenied: () => {},
  };
}

describe('LocationAdapter — BUG 4: async cancellation', () => {
  beforeEach(() => {
    locationState.permissionResolve = null;
    locationState.watchResolve = null;
    locationState.watchRemoveCalled = false;
  });

  it('stop() before permission resolves prevents watch creation', async () => {
    const events = makeEvents();
    const adapter = new LocationAdapter([[52, 21]], [], events);

    const startPromise = adapter.start();

    // User taps End Tour while permission dialog is up.
    adapter.stop();

    // Now resolve the permission.
    expect(locationState.permissionResolve).not.toBeNull();
    locationState.permissionResolve!({ status: 'granted' });
    await startPromise;

    // watchPositionAsync should never have been called (cancelled check after permission).
    // We verify by checking that watchResolve is still null.
    expect(locationState.watchResolve).toBeNull();
  });

  it('stop() after permission but before watch resolves removes the watch', async () => {
    const events = makeEvents();
    const adapter = new LocationAdapter([[52, 21]], [], events);

    const startPromise = adapter.start();

    // Resolve permission.
    expect(locationState.permissionResolve).not.toBeNull();
    locationState.permissionResolve!({ status: 'granted' });

    // Let the microtask queue advance so the code reaches watchPositionAsync.
    await new Promise((r) => setTimeout(r, 0));

    // watchPositionAsync should now be pending.
    expect(locationState.watchResolve).not.toBeNull();

    // Now stop before the watch resolves.
    adapter.stop();

    // Resolve the watch — adapter should immediately remove it.
    const removeFn = jest.fn();
    locationState.watchResolve!({ remove: removeFn });
    await startPromise;

    expect(removeFn).toHaveBeenCalled();
  });
});
