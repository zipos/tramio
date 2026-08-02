const mockShare = jest.fn();

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
  Share: { share: (content: unknown) => mockShare(content) },
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
  Accuracy: { Balanced: 3, High: 4, Highest: 5, BestForNavigation: 6 },
  ActivityType: { Other: 1, AutomotiveNavigation: 2, OtherNavigation: 5 },
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
import { useTourEngine, type UseTourEngineResult } from './useTourEngine';
import type { StartTourConfig } from '../../../engine/src';

let hookResult: UseTourEngineResult | null = null;

function HookProbe(): null {
  hookResult = useTourEngine();
  return null;
}

const DIAGNOSTICS_TEST_CONFIG: StartTourConfig = {
  bundle: { bundleId: 'must-not-leak', bundleVersion: '1.0.0' },
  geofences: [],
  route: [
    [52.1234, 21.5678],
    [52.124, 21.568],
  ],
  language: 'en',
};

describe('useTourEngine production audio wiring', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mockAdapterInstances.length = 0;
    mockShare.mockClear();
    hookResult = null;
  });

  it('owns and releases one fresh audio adapter per hook lifecycle', async () => {
    let first: ReactTestRenderer | undefined;
    await act(async () => {
      first = create(createElement(HookProbe));
    });

    expect(mockAdapterInstances).toHaveLength(1);
    const firstAdapter = mockAdapterInstances[0]!;
    expect(mockShare).not.toHaveBeenCalled();

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

  it('shares only on explicit request and keeps the finalized report redacted', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(createElement(HookProbe));
    });

    expect(mockShare).not.toHaveBeenCalled();

    await act(async () => {
      hookResult!.startTour(DIAGNOSTICS_TEST_CONFIG);
      await Promise.resolve();
    });
    expect(mockShare).not.toHaveBeenCalled();

    await act(async () => {
      hookResult!.endTour();
    });
    expect(mockShare).not.toHaveBeenCalled();

    await act(async () => {
      await hookResult!.shareFieldDiagnostics();
    });

    expect(mockShare).toHaveBeenCalledTimes(1);
    const shared = mockShare.mock.calls[0]![0] as { message: string };
    expect(shared.message).toContain('privacyStatement');
    expect(shared.message).not.toContain('must-not-leak');
    expect(shared.message).not.toContain('52.1234');
    expect(shared.message).not.toContain('21.5678');

    await act(async () => {
      renderer!.unmount();
    });
  });
});
