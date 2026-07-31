// audioSession.test.ts — verifies the audio session configuration module.

jest.mock('expo-audio', () => ({
  setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  setIsAudioActiveAsync: jest.fn().mockResolvedValue(undefined),
}));

import { configureTourAudioSession, releaseTourAudioSession } from './audioSession';

describe('configureTourAudioSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls setAudioModeAsync with background + silent-mode + duck', async () => {
    const { setAudioModeAsync } = await import('expo-audio');
    await configureTourAudioSession();
    expect(setAudioModeAsync).toHaveBeenCalledWith({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'duckOthers',
    });
  });

  it('does not throw when expo-audio module is missing', async () => {
    jest.resetModules();
    jest.mock('expo-audio', () => {
      throw new Error('Cannot find module');
    });
    // Re-import after mock reset to get the fresh module scope.
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- jest.resetModules() invalidates the top-level import; require() is needed to get the fresh module scope
    const { configureTourAudioSession: configure } = require('./audioSession');
    await expect(configure()).resolves.toBeUndefined();
  });
});

describe('releaseTourAudioSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    jest.mock('expo-audio', () => ({
      setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
      setIsAudioActiveAsync: jest.fn().mockResolvedValue(undefined),
    }));
  });

  it('resets the mode and deactivates', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- jest.resetModules() invalidates the top-level import; require() is needed to get the fresh module scope
    const { releaseTourAudioSession: release } = require('./audioSession');
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- same reason: fresh mock after resetModules
    const { setAudioModeAsync, setIsAudioActiveAsync } = require('expo-audio');
    await release();
    expect(setAudioModeAsync).toHaveBeenCalledWith({
      playsInSilentMode: false,
      shouldPlayInBackground: false,
      interruptionMode: 'mixWithOthers',
    });
    expect(setIsAudioActiveAsync).toHaveBeenCalledWith(false);
  });

  it('releases cleanly after configure (full lifecycle)', async () => {
    // Verify the session can be acquired and released without leaking.
    // Uses the top-level imports which share the initial mock scope.
    jest.clearAllMocks();
    jest.resetModules();
    jest.mock('expo-audio', () => ({
      setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
      setIsAudioActiveAsync: jest.fn().mockResolvedValue(undefined),
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires -- fresh module after resetModules for lifecycle test
    const mod = require('./audioSession') as {
      configureTourAudioSession: () => Promise<void>;
      releaseTourAudioSession: () => Promise<void>;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- fresh mock after resetModules
    const expoAudio = require('expo-audio') as {
      setAudioModeAsync: jest.Mock;
      setIsAudioActiveAsync: jest.Mock;
    };

    await mod.configureTourAudioSession();
    await mod.releaseTourAudioSession();

    // Configure should have set background mode, then release should reset it.
    expect(expoAudio.setAudioModeAsync).toHaveBeenCalledTimes(2);
    expect(expoAudio.setAudioModeAsync).toHaveBeenNthCalledWith(1, {
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'duckOthers',
    });
    expect(expoAudio.setAudioModeAsync).toHaveBeenNthCalledWith(2, {
      playsInSilentMode: false,
      shouldPlayInBackground: false,
      interruptionMode: 'mixWithOthers',
    });
    expect(expoAudio.setIsAudioActiveAsync).toHaveBeenCalledWith(false);
  });

  it('uses the top-level releaseTourAudioSession import directly', async () => {
    // This test exercises the original top-level import to ensure it is wired.
    await releaseTourAudioSession();
    // releaseTourAudioSession swallows errors from the dynamic import
    // inside its implementation — this verifies it resolves without throwing.
  });
});
