// Unit tests for the Audio_Service TS wrapper.
//
// Covers the JS-side responsibilities of task 8.3:
//   - bridge contract for play / pause / resume / stop / duck
//   - DecryptStreamHandle path-through (plaintext-free playback)
//   - LUFS gain offset clamping (~ -16 LUFS ±3 dB knob, design.md
//     "Components and Interfaces > Audio_Service")
//   - duck threshold helper (>= 50% rule, Req 10.4)
//   - focus loss / regain event normalization (Req 10.1, 10.2)
//   - listener detach round-trip
//
// Native-side behavior (AVAudioPlayer, AVAudioSession interruption
// notifications, true LUFS measurement) is covered by instrumented
// device tests in task 8.7. These unit tests stay above the bridge.

import { AudioService } from './AudioService';
import { FakeAudioBridge } from './FakeAudioBridge';
import {
  DUCK_ACTIVE_THRESHOLD_PERCENT,
  GAIN_OFFSET_DB_MAX,
  GAIN_OFFSET_DB_MIN,
} from './NativeAudioService';
import type { AudioServiceEvent, DecryptStreamHandle } from './types';

const HANDLE = 'native-stream-handle://poi-rynek/segment-1' as DecryptStreamHandle;

function setup(): { bridge: FakeAudioBridge; svc: AudioService } {
  const bridge = new FakeAudioBridge();
  const svc = new AudioService(bridge);
  return { bridge, svc };
}

describe('AudioService.playStream', () => {
  it('forwards the segmentId and a stream-kind source to the bridge', async () => {
    const { bridge, svc } = setup();

    await svc.playStream('seg-1', HANDLE);

    expect(bridge.lastPlay?.segmentId).toBe('seg-1');
    expect(bridge.lastPlay?.source).toEqual({ kind: 'stream', handle: HANDLE });
  });

  it('clamps gainOffsetDb to ±12 dB (LUFS tolerance band)', async () => {
    const { bridge, svc } = setup();

    await svc.playStream('seg-hi', HANDLE, { gainOffsetDb: 99 });
    expect(bridge.getCurrentGainOffsetDb()).toBe(GAIN_OFFSET_DB_MAX);

    await svc.playStream('seg-lo', HANDLE, { gainOffsetDb: -99 });
    expect(bridge.getCurrentGainOffsetDb()).toBe(GAIN_OFFSET_DB_MIN);
  });

  it('preserves an in-band gainOffsetDb verbatim', async () => {
    const { bridge, svc } = setup();
    await svc.playStream('seg-ok', HANDLE, { gainOffsetDb: -3 });
    expect(bridge.getCurrentGainOffsetDb()).toBe(-3);
  });

  it('clamps a non-numeric gainOffsetDb to the minimum (NaN guard)', async () => {
    const { bridge, svc } = setup();
    await svc.playStream('seg-nan', HANDLE, { gainOffsetDb: Number.NaN });
    expect(bridge.getCurrentGainOffsetDb()).toBe(GAIN_OFFSET_DB_MIN);
  });

  it('clamps initialDuckPercent to [0, 100]', async () => {
    const { bridge, svc } = setup();

    await svc.playStream('seg-1', HANDLE, { initialDuckPercent: 250 });
    expect(bridge.getCurrentDuckPercent()).toBe(100);

    await svc.playStream('seg-2', HANDLE, { initialDuckPercent: -10 });
    expect(bridge.getCurrentDuckPercent()).toBe(0);
  });

  it('rejects empty segmentId', async () => {
    const { svc } = setup();
    await expect(svc.playStream('', HANDLE)).rejects.toThrow(/segmentId/);
  });

  it('replaces any in-flight segment to preserve the |playing| <= 1 invariant', async () => {
    const { bridge, svc } = setup();
    await svc.playStream('seg-a', HANDLE);
    await svc.playStream('seg-b', HANDLE);
    expect(bridge.getCurrentSegmentId()).toBe('seg-b');
  });
});

describe('AudioService.playUrl', () => {
  it('forwards a url-kind source for unprotected playback', async () => {
    const { bridge, svc } = setup();
    await svc.playUrl('standby-1', 'file:///pack/standby/trivia-1.m4a');
    expect(bridge.lastPlay?.source).toEqual({
      kind: 'url',
      url: 'file:///pack/standby/trivia-1.m4a',
    });
  });
});

describe('AudioService.pause / resume', () => {
  it('captures the offset on pause and round-trips it through resume', async () => {
    const { bridge, svc } = setup();
    await svc.playStream('seg-a', HANDLE, { startOffsetMs: 1234 });

    const offset = await svc.pause();
    expect(offset).toBe(1234);

    await svc.resume(offset);
    expect(bridge.getCurrentOffsetMs()).toBe(1234);
  });

  it('clamps a negative resume offset to zero', async () => {
    const { bridge, svc } = setup();
    await svc.playStream('seg-a', HANDLE);
    await svc.resume(-50);
    expect(bridge.getCurrentOffsetMs()).toBe(0);
  });

  it('floors a fractional resume offset for cross-platform stability', async () => {
    const { bridge, svc } = setup();
    await svc.playStream('seg-a', HANDLE);
    await svc.resume(99.9);
    expect(bridge.getCurrentOffsetMs()).toBe(99);
  });
});

describe('AudioService.duck', () => {
  it('clamps the percent argument to [0, 100]', async () => {
    const { bridge, svc } = setup();
    await svc.duck(150);
    expect(bridge.getCurrentDuckPercent()).toBe(100);
    await svc.duck(-5);
    expect(bridge.getCurrentDuckPercent()).toBe(0);
  });

  it('emits onDuckingChange with the clamped percent', async () => {
    const { svc } = setup();
    const events: number[] = [];
    svc.on('DuckingChange', (ev) => events.push(ev.percent));
    await svc.duck(60);
    await svc.duck(150);
    expect(events).toEqual([60, 100]);
  });

  it('isDuckActive reports >= 50% as active per Req 10.4', () => {
    expect(AudioService.isDuckActive(DUCK_ACTIVE_THRESHOLD_PERCENT)).toBe(true);
    expect(AudioService.isDuckActive(DUCK_ACTIVE_THRESHOLD_PERCENT - 1)).toBe(false);
    expect(AudioService.isDuckActive(100)).toBe(true);
  });
});

describe('AudioService event normalization', () => {
  it('delivers PlaybackFinished events with kind discriminator', async () => {
    const { bridge, svc } = setup();
    const seen: AudioServiceEvent[] = [];
    svc.on('PlaybackFinished', (ev) => seen.push(ev));

    await svc.playStream('seg-a', HANDLE);
    bridge.emitPlaybackFinished('completed');

    expect(seen).toEqual([{ kind: 'PlaybackFinished', segmentId: 'seg-a', reason: 'completed' }]);
  });

  it('delivers FocusLoss with the captured offset (Req 10.1)', async () => {
    const { bridge, svc } = setup();
    const seen: AudioServiceEvent[] = [];
    svc.on('FocusLoss', (ev) => seen.push(ev));

    await svc.playStream('seg-a', HANDLE, { startOffsetMs: 4200 });
    bridge.emitFocusLoss();

    expect(seen).toEqual([{ kind: 'FocusLoss', capturedOffsetMs: 4200, segmentId: 'seg-a' }]);
  });

  it('delivers FocusRegain so the engine can resume from the captured offset', async () => {
    const { bridge, svc } = setup();
    const seen: AudioServiceEvent[] = [];
    svc.on('FocusRegain', (ev) => seen.push(ev));

    await svc.playStream('seg-a', HANDLE);
    bridge.emitFocusRegain();

    expect(seen).toEqual([{ kind: 'FocusRegain', segmentId: 'seg-a' }]);
  });

  it('returns an Unsubscribe that detaches the listener', async () => {
    const { bridge, svc } = setup();
    const seen: AudioServiceEvent[] = [];

    const off = svc.on('PlaybackFinished', (ev) => seen.push(ev));
    await svc.playStream('seg-a', HANDLE);
    off();
    bridge.emitPlaybackFinished('completed');

    expect(seen).toEqual([]);
  });

  it('removeAllListeners detaches every wrapper-owned subscription', async () => {
    const { bridge, svc } = setup();
    svc.on('PlaybackFinished', () => {});
    svc.on('FocusLoss', () => {});
    expect(bridge.listenerCount()).toBe(2);

    svc.removeAllListeners();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('onAny multiplexes every event kind through one callback', async () => {
    const { bridge, svc } = setup();
    const kinds: string[] = [];
    svc.onAny((ev) => kinds.push(ev.kind));

    await svc.playStream('seg-a', HANDLE);
    bridge.emitFocusLoss();
    bridge.emitFocusRegain();
    await svc.duck(75);
    bridge.emitPlaybackFinished('completed');

    // Order: FocusLoss, FocusRegain, DuckingChange, PlaybackFinished.
    expect(kinds).toEqual(['FocusLoss', 'FocusRegain', 'DuckingChange', 'PlaybackFinished']);
  });
});

describe('AudioService bridge contract', () => {
  it('serializes source and opts so the bridge sees JSON strings', async () => {
    const { bridge, svc } = setup();
    await svc.playStream('seg-a', HANDLE, { startOffsetMs: 100, gainOffsetDb: -2 });

    const playCall = bridge.calls.find((c) => c.method === 'play');
    expect(playCall).toBeDefined();
    const [segmentId, sourceJson, optsJson] = playCall!.args as [string, string, string];
    expect(segmentId).toBe('seg-a');
    expect(typeof sourceJson).toBe('string');
    expect(typeof optsJson).toBe('string');
    expect(JSON.parse(sourceJson)).toEqual({ kind: 'stream', handle: HANDLE });
    expect(JSON.parse(optsJson)).toEqual({
      startOffsetMs: 100,
      gainOffsetDb: -2,
      initialDuckPercent: 0,
    });
  });

  it('stop() is callable when no segment is active and stays idempotent', async () => {
    const { bridge, svc } = setup();
    await svc.stop();
    await svc.stop();
    expect(bridge.calls.filter((c) => c.method === 'stop')).toHaveLength(2);
  });
});
