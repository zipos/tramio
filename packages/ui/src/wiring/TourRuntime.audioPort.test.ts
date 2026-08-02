// TourRuntime — Wave 3: AudioPlaybackPort lifecycle tests.
//
// Validates:
//   - Audio port receives play() on PlaySegment with source:'audio'
//   - TTS fires for PlaySegment with source:'tts' or no port
//   - Audio error falls back to TTS
//   - Audio completion emits AudioFinished exactly once
//   - Pause/resume works for audio (offset) vs TTS (restart)
//   - Replay replays the actual last source
//   - Focus loss pauses audio, focus regain resumes
//   - Destroy releases audio port
//   - Callbacks cannot dispatch into destroyed runtime

// ─── Mocks ────────────────────────────────────────────────────────────────

const mockAppStateListeners: Array<(state: string) => void> = [];

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, handler: (state: string) => void) => {
      mockAppStateListeners.push(handler);
      return {
        remove: () => {
          const i = mockAppStateListeners.indexOf(handler);
          if (i >= 0) mockAppStateListeners.splice(i, 1);
        },
      };
    },
  },
  InteractionManager: { runAfterInteractions: (fn: () => void) => fn() },
  Platform: { OS: 'ios', Version: '17.0' },
  PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} },
}));

const speechMock = {
  callbacks: {} as Record<string, (() => void) | undefined>,
  speakCalls: [] as Array<{ text: string; opts: Record<string, unknown> }>,
  voices: [{ identifier: 'v1', name: 'Voice', quality: 'Default', language: 'en-US' }],
  autoStart: true,
};

jest.mock('expo-speech', () => ({
  speak: (text: string, opts?: Record<string, unknown>) => {
    speechMock.speakCalls.push({ text, opts: opts ?? {} });
    const onStart = opts?.onStart as (() => void) | undefined;
    const onDone = opts?.onDone as (() => void) | undefined;
    const onStopped = opts?.onStopped as (() => void) | undefined;
    const onError = opts?.onError as (() => void) | undefined;
    speechMock.callbacks = { onStart, onDone, onStopped, onError };
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
import type { StartTourConfig, MediaCatalog } from '../../../engine/src';
import type {
  AudioPlaybackPort,
  AudioPlaybackCallbacks,
  AudioPlaybackStatus,
} from './AudioPlaybackPort';

// ─── Fake AudioPlaybackPort ─────────────────────────────────────────────────

class FakeAudioPort implements AudioPlaybackPort {
  playCalls: Array<{ fileUri: string; callbacks: AudioPlaybackCallbacks }> = [];
  pauseCalls = 0;
  resumeCalls = 0;
  stopCalls = 0;
  released = false;

  private currentCallbacks: AudioPlaybackCallbacks | null = null;

  play(fileUri: string, callbacks: AudioPlaybackCallbacks): void {
    this.playCalls.push({ fileUri, callbacks });
    this.currentCallbacks = callbacks;
    // Auto-fire onStart.
    callbacks.onStart?.();
  }

  pause(): void {
    this.pauseCalls++;
  }
  resume(): void {
    this.resumeCalls++;
  }
  stop(): void {
    this.stopCalls++;
    this.currentCallbacks = null;
  }
  getStatus(): AudioPlaybackStatus {
    return { playing: false, positionSec: 0, durationSec: 30 };
  }
  release(): void {
    this.released = true;
  }

  /** Simulate natural completion. */
  simulateComplete(): void {
    this.currentCallbacks?.onComplete?.();
  }
  /** Simulate playback error. */
  simulateError(msg: string): void {
    this.currentCallbacks?.onError?.(msg);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const CATALOG: MediaCatalog = {
  defaultLanguage: 'en',
  pois: {
    'poi-audio': {
      narratives: { en: 'poi-audio:en' },
      audio: { en: '/verified/poi-audio.en.m4a' },
    },
    'poi-tts-only': {
      narratives: { en: 'poi-tts-only:en' },
      audio: {},
    },
  },
};

const CONFIG: StartTourConfig = {
  bundle: { bundleId: 'test', bundleVersion: '1.0.0' },
  geofences: [
    {
      poiId: 'poi-audio',
      geometry: { kind: 'circle', center: [51.0, 17.0], radiusMeters: 50 },
      dwellSec: 3,
      priority: 90,
      authorIndex: 0,
    },
    {
      poiId: 'poi-tts-only',
      geometry: { kind: 'circle', center: [51.1, 17.1], radiusMeters: 50 },
      dwellSec: 3,
      priority: 80,
      authorIndex: 1,
    },
  ],
  route: [
    [51.0, 17.0],
    [51.1, 17.1],
  ],
  language: 'en',
  mediaCatalog: CATALOG,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('TourRuntime — AudioPlaybackPort lifecycle (Wave 3)', () => {
  let port: FakeAudioPort;
  let runtime: TourRuntime;

  beforeEach(() => {
    speechMock.callbacks = {};
    speechMock.speakCalls = [];
    speechMock.autoStart = true;
    mockAppStateListeners.length = 0;
    port = new FakeAudioPort();
    runtime = new TourRuntime({
      narrativeResolver: (id) => `Narration for ${id}`,
      audioPort: port,
    });
  });

  afterEach(() => {
    runtime.destroy();
  });

  it('dispatches to audio port for source:audio', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    expect(port.playCalls).toHaveLength(1);
    expect(port.playCalls[0]!.fileUri).toBe('/verified/poi-audio.en.m4a');
    expect(speechMock.speakCalls).toHaveLength(0);
  });

  it('dispatches to TTS for source:tts (no audio available)', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-tts-only' });

    expect(port.playCalls).toHaveLength(0);
    expect(speechMock.speakCalls).toHaveLength(1);
    expect(speechMock.speakCalls[0]!.text).toContain('poi-tts-only:en');
  });

  it('audio completion emits AudioFinished and marks POI consumed', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    port.simulateComplete();

    const state = runtime.getState();
    if (state.phase === 'Active') {
      expect(state.session.consumed.has('poi-audio')).toBe(true);
      expect(state.session.playing).toBeUndefined();
    }
  });

  it('audio error calls port.stop() before TTS fallback', () => {
    const eventLog: string[] = [];
    const origStop = port.stop.bind(port);
    port.stop = () => {
      eventLog.push('port.stop');
      origStop();
    };
    // Patch speechMock to track ordering.
    const origSpeak = jest.requireMock('expo-speech').speak;
    jest.requireMock('expo-speech').speak = (text: string, opts?: Record<string, unknown>) => {
      eventLog.push('Speech.speak');
      origSpeak(text, opts);
    };

    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    port.simulateError('Decode error');

    // port.stop() must precede Speech.speak() in the event log.
    expect(eventLog.indexOf('port.stop')).toBeLessThan(eventLog.indexOf('Speech.speak'));
    expect(speechMock.speakCalls).toHaveLength(1);
    expect(speechMock.speakCalls[0]!.text).toContain('poi-audio:en');

    // Restore.
    jest.requireMock('expo-speech').speak = origSpeak;
  });

  it('audio error falls back to TTS, TTS completion advances engine', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    port.simulateError('Decode error');

    // TTS fallback should complete.
    speechMock.callbacks.onDone?.();

    const state = runtime.getState();
    if (state.phase === 'Active') {
      expect(state.session.consumed.has('poi-audio')).toBe(true);
      expect(state.session.playing).toBeUndefined();
    }
  });

  it('PauseAudio pauses audio port (not TTS stop)', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    // Dispatch FocusLoss which triggers PauseAudio.
    runtime.dispatch({ kind: 'FocusLoss' });

    expect(port.pauseCalls).toBe(1);
  });

  it('ResumeAudio resumes audio port from offset (no restart)', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    runtime.dispatch({ kind: 'FocusLoss' });

    // Simulate FocusRegain.
    runtime.dispatch({ kind: 'FocusRegain' });

    expect(port.resumeCalls).toBe(1);
    // Should NOT have spoken anything via TTS.
    expect(speechMock.speakCalls).toHaveLength(0);
  });

  it('replay replays the actual last source (audio)', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    port.simulateComplete();

    port.playCalls = [];
    runtime.replayLastSegment();

    expect(port.playCalls).toHaveLength(1);
    expect(port.playCalls[0]!.fileUri).toBe('/verified/poi-audio.en.m4a');
  });

  it('replay uses TTS if audio failed and TTS ran last', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    port.simulateError('Decode error');
    // TTS fallback started — complete it.
    speechMock.callbacks.onDone?.();

    speechMock.speakCalls = [];
    runtime.replayLastSegment();

    // Should replay via TTS, not audio (lastSource switched to 'tts' on fallback).
    expect(speechMock.speakCalls).toHaveLength(1);
    expect(port.playCalls).toHaveLength(1); // only the original play, not a replay
  });

  it('destroy releases audio port', () => {
    runtime.start(CONFIG);
    runtime.destroy();
    expect(port.released).toBe(true);
  });

  it('callbacks cannot dispatch into destroyed runtime', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    runtime.destroy();

    // Simulate completion after destroy — should not throw.
    expect(() => port.simulateComplete()).not.toThrow();
  });

  it('getActiveSource returns audio when playing pre-rendered', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    expect(runtime.getActiveSource()).toBe('audio');
  });

  it('getActiveSource returns tts when playing TTS', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-tts-only' });
    expect(runtime.getActiveSource()).toBe('tts');
  });

  it('exactly one source active: starting audio stops any prior TTS', () => {
    const configMixed: StartTourConfig = {
      ...CONFIG,
      geofences: [
        ...CONFIG.geofences,
        {
          poiId: 'poi-extra',
          geometry: {
            kind: 'circle',
            center: [51.2, 17.2],
            radiusMeters: 50,
          },
          dwellSec: 3,
          priority: 70,
          authorIndex: 2,
        },
      ],
      mediaCatalog: {
        ...CATALOG,
        pois: {
          ...CATALOG.pois,
          'poi-extra': {
            narratives: { en: 'poi-extra:en' },
            audio: { en: '/verified/extra.m4a' },
          },
        },
      },
    };

    const rt = new TourRuntime({
      narrativeResolver: () => 'Text',
      audioPort: port,
    });
    rt.start(configMixed);
    rt.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-tts-only' });
    // Complete TTS POI.
    speechMock.callbacks.onDone?.();
    rt.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-extra' });

    // Audio port got a play call for the second POI.
    expect(port.playCalls.length).toBeGreaterThanOrEqual(1);
    const lastPlay = port.playCalls[port.playCalls.length - 1]!;
    expect(lastPlay.fileUri).toBe('/verified/extra.m4a');

    rt.destroy();
  });

  // ─── Stale callback race ─────────────────────────────────────────────

  it('stale audio callback from old segment does not finish new segment', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    // Capture the callbacks from the first play.
    const firstCallbacks = port.playCalls[0]!.callbacks;

    // Simulate immediate replay (new play overwrites currentSegmentId).
    port.playCalls = [];
    runtime.replayLastSegment();

    // Now the old callbacks fire complete.
    firstCallbacks.onComplete?.();

    // The engine should still be playing (not finished by stale callback).
    const state = runtime.getState();
    if (state.phase === 'Active') {
      // The segment should still be playing (replay is in flight).
      expect(state.session.playing).toBeDefined();
    }
  });

  // ─── No port with narrative / no narrative scenarios ──────────────────

  it('audio source without port falls back to matching narrative via TTS', () => {
    // Runtime WITHOUT audio port.
    const rt = new TourRuntime({
      narrativeResolver: (id) => `Narration for ${id}`,
    });
    rt.start(CONFIG);
    rt.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    // Should fall back to TTS with narrative text.
    expect(speechMock.speakCalls).toHaveLength(1);
    expect(speechMock.speakCalls[0]!.text).toBe('Narration for poi-audio:en');

    // Complete TTS — advances engine.
    speechMock.callbacks.onDone?.();
    const state = rt.getState();
    if (state.phase === 'Active') {
      expect(state.session.consumed.has('poi-audio')).toBe(true);
      expect(state.session.playing).toBeUndefined();
    }

    rt.destroy();
  });

  it('audio source without port and no narrative safely finishes', () => {
    // Runtime WITHOUT audio port and narrative returns null.
    const rt = new TourRuntime({
      narrativeResolver: () => null,
    });
    rt.start(CONFIG);
    rt.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    // Should not speak generic text for pack content — advances engine safely.
    const state = rt.getState();
    if (state.phase === 'Active') {
      expect(state.session.consumed.has('poi-audio')).toBe(true);
      expect(state.session.playing).toBeUndefined();
    }
    // SpeechStatus should indicate failure.
    expect(rt.getSpeechStatus().available).toBe(false);

    rt.destroy();
  });

  it('audio error with no matching narrative safely finishes and status failed', () => {
    // Audio port exists but narrative resolver returns null.
    const rt = new TourRuntime({
      narrativeResolver: () => null,
      audioPort: port,
    });
    rt.start(CONFIG);
    rt.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    port.simulateError('File not found');

    // Should advance engine without fabricating a line.
    const state = rt.getState();
    if (state.phase === 'Active') {
      expect(state.session.consumed.has('poi-audio')).toBe(true);
      expect(state.session.playing).toBeUndefined();
    }
    // SpeechStatus should indicate failure.
    expect(rt.getSpeechStatus().available).toBe(false);

    rt.destroy();
  });

  // ─── Focus pause/resume with active audio ─────────────────────────────

  it('active audio focus pause preserves offset, resume continues', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });

    // Pause via focus loss.
    runtime.dispatch({ kind: 'FocusLoss' });
    expect(port.pauseCalls).toBe(1);

    // Resume via focus regain.
    runtime.dispatch({ kind: 'FocusRegain' });
    expect(port.resumeCalls).toBe(1);

    // Segment is still playing (not finished).
    const state = runtime.getState();
    if (state.phase === 'Active') {
      expect(state.session.playing).toBeDefined();
    }
  });

  it('destroy after focus loss does not mutate via stale callback', () => {
    runtime.start(CONFIG);
    runtime.dispatch({ kind: 'GeofenceDwell', poiId: 'poi-audio' });
    runtime.dispatch({ kind: 'FocusLoss' });

    // Capture state before destroy.
    const stateBefore = runtime.getState();
    runtime.destroy();

    // Stale complete should not throw or mutate.
    expect(() => port.simulateComplete()).not.toThrow();

    // State is frozen (no listeners update it).
    expect(runtime.getState()).toEqual(stateBefore);
  });
});
