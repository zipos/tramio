/**
 * Unit tests for `createNativeTtsEngine` (task 8.5).
 *
 * Verifies that the JS wrapper:
 *   - Forwards `speak`, `pause`, `resume`, `stop` to the native binding.
 *   - Fans the unified native event stream into Audio_Service-shaped
 *     `onPlaybackFinished`, `onFocusLoss`, `onFocusRegain` listeners
 *     (so task 13.1 can wire either backend without branching).
 *   - Allows multiple subscribers per event and lets each unsubscribe
 *     independently.
 *   - Drops the underlying native subscription on `release()`.
 */

import { createNativeTtsEngine } from './NativeTtsEngine';
import type {
  NativeTtsEngineBinding,
  SpeakOptions,
  TtsPlaybackEvent,
  TtsPlaybackListener,
  Unsubscribe,
} from './types';

interface FakeBinding extends NativeTtsEngineBinding {
  emit(event: TtsPlaybackEvent): void;
  readonly calls: {
    readonly speak: ReadonlyArray<{ text: string; opts: SpeakOptions }>;
    readonly pause: number;
    readonly resume: number;
    readonly stop: number;
    readonly addPlaybackListener: number;
  };
  readonly listenerCount: () => number;
}

function makeFakeBinding(): FakeBinding {
  const speakCalls: Array<{ text: string; opts: SpeakOptions }> = [];
  let pauseCalls = 0;
  let resumeCalls = 0;
  let stopCalls = 0;
  let addCalls = 0;
  const listeners = new Set<TtsPlaybackListener>();

  return {
    speak(text: string, opts: SpeakOptions): Promise<void> {
      speakCalls.push({ text, opts });
      return Promise.resolve();
    },
    pause(): Promise<void> {
      pauseCalls += 1;
      return Promise.resolve();
    },
    resume(): Promise<void> {
      resumeCalls += 1;
      return Promise.resolve();
    },
    stop(): Promise<void> {
      stopCalls += 1;
      return Promise.resolve();
    },
    addPlaybackListener(listener: TtsPlaybackListener): Unsubscribe {
      addCalls += 1;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: TtsPlaybackEvent): void {
      for (const l of listeners) l(event);
    },
    get calls() {
      return {
        speak: speakCalls,
        pause: pauseCalls,
        resume: resumeCalls,
        stop: stopCalls,
        addPlaybackListener: addCalls,
      };
    },
    listenerCount(): number {
      return listeners.size;
    },
  };
}

describe('createNativeTtsEngine — method forwarding', () => {
  it('forwards speak/pause/resume/stop to the native binding', async () => {
    const binding = makeFakeBinding();
    const engine = createNativeTtsEngine(binding);

    const opts: SpeakOptions = {
      segmentId: 'poi-rynek',
      language: 'en',
      defaultLanguage: 'pl',
    };
    await engine.speak('Welcome to Rynek.', opts);
    await engine.pause();
    await engine.resume();
    await engine.stop();

    expect(binding.calls.speak).toEqual([{ text: 'Welcome to Rynek.', opts }]);
    expect(binding.calls.pause).toBe(1);
    expect(binding.calls.resume).toBe(1);
    expect(binding.calls.stop).toBe(1);
  });

  it('opens exactly one binding-level subscription regardless of JS listener count', () => {
    const binding = makeFakeBinding();
    const engine = createNativeTtsEngine(binding);
    engine.onPlaybackFinished(() => {});
    engine.onPlaybackFinished(() => {});
    engine.onFocusLoss(() => {});
    engine.onFocusRegain(() => {});
    expect(binding.calls.addPlaybackListener).toBe(1);
    expect(binding.listenerCount()).toBe(1);
  });
});

describe('createNativeTtsEngine — event fan-out', () => {
  it('routes PlaybackFinished to onPlaybackFinished subscribers with the segmentId payload', () => {
    const binding = makeFakeBinding();
    const engine = createNativeTtsEngine(binding);
    const a = jest.fn();
    const b = jest.fn();
    engine.onPlaybackFinished(a);
    engine.onPlaybackFinished(b);

    binding.emit({ kind: 'PlaybackFinished', segmentId: 'poi-rynek' });
    expect(a).toHaveBeenCalledWith({ segmentId: 'poi-rynek' });
    expect(b).toHaveBeenCalledWith({ segmentId: 'poi-rynek' });
  });

  it('routes FocusLoss / FocusRegain only to their respective subscribers', () => {
    const binding = makeFakeBinding();
    const engine = createNativeTtsEngine(binding);
    const onLoss = jest.fn();
    const onRegain = jest.fn();
    const onFinished = jest.fn();
    engine.onFocusLoss(onLoss);
    engine.onFocusRegain(onRegain);
    engine.onPlaybackFinished(onFinished);

    binding.emit({ kind: 'FocusLoss' });
    expect(onLoss).toHaveBeenCalledTimes(1);
    expect(onRegain).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();

    binding.emit({ kind: 'FocusRegain' });
    expect(onRegain).toHaveBeenCalledTimes(1);
    expect(onLoss).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('lets each subscriber unsubscribe independently', () => {
    const binding = makeFakeBinding();
    const engine = createNativeTtsEngine(binding);
    const a = jest.fn();
    const b = jest.fn();
    const unsubA = engine.onPlaybackFinished(a);
    engine.onPlaybackFinished(b);

    unsubA();
    binding.emit({ kind: 'PlaybackFinished', segmentId: 'poi-1' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith({ segmentId: 'poi-1' });
  });
});

describe('createNativeTtsEngine — release', () => {
  it('detaches the native subscription and clears all JS listeners', () => {
    const binding = makeFakeBinding();
    const engine = createNativeTtsEngine(binding);
    const finished = jest.fn();
    const lost = jest.fn();
    engine.onPlaybackFinished(finished);
    engine.onFocusLoss(lost);
    expect(binding.listenerCount()).toBe(1);

    engine.release();
    expect(binding.listenerCount()).toBe(0);

    binding.emit({ kind: 'PlaybackFinished', segmentId: 'poi-1' });
    binding.emit({ kind: 'FocusLoss' });
    expect(finished).not.toHaveBeenCalled();
    expect(lost).not.toHaveBeenCalled();
  });

  it('is idempotent on repeated calls', () => {
    const binding = makeFakeBinding();
    const engine = createNativeTtsEngine(binding);
    expect(() => {
      engine.release();
      engine.release();
    }).not.toThrow();
  });
});
