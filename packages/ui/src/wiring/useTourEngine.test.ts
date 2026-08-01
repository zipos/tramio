// Production audio wiring lifecycle test.

const mockAdapterInstances: Array<{
  play: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  stop: jest.Mock;
  getStatus: jest.Mock;
  release: jest.Mock;
}> = [];

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({ remove: () => {} }),
  },
  InteractionManager: { runAfterInteractions: (fn: () => void) => fn() },
  Platform: { OS: 'ios', Version: '17.0' },
  PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
}));

jest.mock('expo-speech', () => ({
  speak: () => {},
  stop: () => Promise.resolve(),
  getAvailableVoicesAsync: () => Promise.resolve([]),
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
  Accuracy: { High: 6 },
  PermissionStatus: { GRANTED: 'granted' },
}));

jest.mock('expo-task-manager', () => ({
  isTaskDefined: () => true,
  defineTask: () => {},
}));

jest.mock('./ExpoAudioPlaybackAdapter', () => ({
  ExpoAudioPlaybackAdapter: class MockExpoAudioPlaybackAdapter {
    constructor() {
      const instance = {
        play: jest.fn(),
        pause: jest.fn(),
        resume: jest.fn(),
        stop: jest.fn(),
        getStatus: jest.fn().mockReturnValue({ playing: false, positionSec: 0, durationSec: 0 }),
        release: jest.fn(),
      };
      mockAdapterInstances.push(instance);
      return instance;
    }
  },
}));

import { createElement } from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { useTourEngine } from './useTourEngine';

function HookProbe(): null {
  useTourEngine();
  return null;
}

describe('useTourEngine production audio wiring', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mockAdapterInstances.length = 0;
  });

  it('owns and releases one fresh audio adapter per hook lifecycle', async () => {
    let first: ReactTestRenderer | undefined;
    await act(async () => {
      first = create(createElement(HookProbe));
    });

    expect(mockAdapterInstances).toHaveLength(1);
    const firstAdapter = mockAdapterInstances[0]!;

    await act(async () => {
      first!.unmount();
    });
    expect(firstAdapter.release).toHaveBeenCalledTimes(1);

    let second: ReactTestRenderer | undefined;
    await act(async () => {
      second = create(createElement(HookProbe));
    });

    expect(mockAdapterInstances).toHaveLength(2);
    expect(mockAdapterInstances[1]).not.toBe(firstAdapter);

    await act(async () => {
      second!.unmount();
    });
    expect(mockAdapterInstances[1]!.release).toHaveBeenCalledTimes(1);
  });
});
