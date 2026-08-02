// gpsReplay.test.ts

import { buildDeskTrace, startGpsReplay, type GpsReplayClock, type ReplayFix } from './gpsReplay';

function makeFakeClock(): GpsReplayClock & { advance(ms: number): void; current: number } {
  let current = 0;
  const timers: Array<{ fn: () => void; due: number; id: number }> = [];
  let nextId = 1;
  return {
    get current() {
      return current;
    },
    now: () => current,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, due: current + ms, id });
      return id;
    },
    clearTimeout: (handle) => {
      const idx = timers.findIndex((t) => t.id === handle);
      if (idx >= 0) timers.splice(idx, 1);
    },
    advance(ms: number) {
      current += ms;
      timers.sort((a, b) => a.due - b.due);
      while (timers.length > 0 && timers[0]!.due <= current) {
        const t = timers.shift()!;
        t.fn();
      }
    },
  };
}

describe('gpsReplay', () => {
  it('buildDeskTrace dwells at waypoints', () => {
    const fixes = buildDeskTrace({
      waypoints: [
        [52.0, 21.0],
        [52.001, 21.0],
      ],
      speedMps: 8,
      fixIntervalMs: 1000,
      dwellMs: 4000,
    });
    expect(fixes.length).toBeGreaterThan(4);
    expect(fixes[0]!.offsetMs).toBe(0);
    expect(fixes[fixes.length - 1]!.offsetMs).toBeGreaterThan(0);
  });

  it('startGpsReplay delivers fixes in order at accelerated wall time', () => {
    const clock = makeFakeClock();
    const fixes: ReplayFix[] = [
      { coord: [52, 21], offsetMs: 0, accuracyM: 10 },
      { coord: [52.001, 21], offsetMs: 4000, accuracyM: 10 },
    ];
    const received: number[] = [];
    let completed = false;
    startGpsReplay({
      fixes,
      speedMultiplier: 4,
      clock,
      onFix: (loc) => received.push(loc.coords.latitude),
      onComplete: () => {
        completed = true;
      },
    });
    clock.advance(0);
    expect(received).toEqual([52]);
    // 4000 ms trace / 4x = 1000 ms wall
    clock.advance(1000);
    expect(received).toEqual([52, 52.001]);
    expect(completed).toBe(true);
  });

  it('setSpeedMultiplier retunes remaining schedule', () => {
    const clock = makeFakeClock();
    const fixes: ReplayFix[] = [
      { coord: [52, 21], offsetMs: 0, accuracyM: 10 },
      { coord: [52.001, 21], offsetMs: 4000, accuracyM: 10 },
    ];
    const received: number[] = [];
    const handle = startGpsReplay({
      fixes,
      speedMultiplier: 1,
      clock,
      onFix: (loc) => received.push(loc.coords.latitude),
    });
    clock.advance(0);
    expect(received).toEqual([52]);
    handle.setSpeedMultiplier(4);
    expect(handle.getSpeedMultiplier()).toBe(4);
    // Remaining 4000 ms trace / 4x ≈ 1000 ms from retune point
    clock.advance(1000);
    expect(received).toEqual([52, 52.001]);
  });

  it('stop() cancels pending fixes', () => {
    const clock = makeFakeClock();
    const fixes: ReplayFix[] = [
      { coord: [52, 21], offsetMs: 0, accuracyM: 10 },
      { coord: [52.001, 21], offsetMs: 4000, accuracyM: 10 },
    ];
    const received: number[] = [];
    const handle = startGpsReplay({
      fixes,
      speedMultiplier: 1,
      clock,
      onFix: (loc) => received.push(loc.coords.latitude),
    });
    clock.advance(0);
    handle.stop();
    clock.advance(5000);
    expect(received).toEqual([52]);
  });

  it('catch-up at high speed assigns increasing trace timestamps', () => {
    const clock = makeFakeClock();
    const fixes: ReplayFix[] = [
      { coord: [52, 21], offsetMs: 0, accuracyM: 10 },
      { coord: [52.001, 21], offsetMs: 1000, accuracyM: 10 },
      { coord: [52.002, 21], offsetMs: 2000, accuracyM: 10 },
      { coord: [52.003, 21], offsetMs: 3000, accuracyM: 10 },
    ];
    const stamps: number[] = [];
    startGpsReplay({
      fixes,
      speedMultiplier: 8,
      clock,
      onFix: (loc) => stamps.push(loc.timestamp),
      heartbeatIntervalMs: 0,
    });
    // At t=0 only the first fix is due (offset 0).
    clock.advance(0);
    expect(stamps).toHaveLength(1);
    // 3000 ms trace / 8x = 375 ms wall — all remaining due in one catch-up.
    clock.advance(375);
    expect(stamps).toHaveLength(4);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    }
  });

  it('seekToCoord jumps the cursor and resumes', () => {
    const clock = makeFakeClock();
    const fixes: ReplayFix[] = [
      { coord: [52, 21], offsetMs: 0, accuracyM: 10 },
      { coord: [52.001, 21], offsetMs: 4000, accuracyM: 10 },
      { coord: [52.002, 21], offsetMs: 8000, accuracyM: 10 },
    ];
    const received: number[] = [];
    const handle = startGpsReplay({
      fixes,
      speedMultiplier: 1,
      clock,
      onFix: (loc) => received.push(loc.coords.latitude),
      heartbeatIntervalMs: 0,
    });
    clock.advance(0);
    expect(received).toEqual([52]);
    expect(handle.seekToCoord([52.002, 21], 50)).toBe(true);
    expect(received).toEqual([52, 52.002]);
    expect(handle.isComplete()).toBe(true);
  });

  it('heartbeat keeps emitting after complete', () => {
    const clock = makeFakeClock();
    const fixes: ReplayFix[] = [{ coord: [52, 21], offsetMs: 0, accuracyM: 10 }];
    const received: number[] = [];
    startGpsReplay({
      fixes,
      speedMultiplier: 1,
      clock,
      onFix: (loc) => received.push(loc.coords.latitude),
      heartbeatIntervalMs: 1000,
    });
    clock.advance(0);
    expect(received).toEqual([52]);
    expect(received).toHaveLength(1);
    clock.advance(1000);
    expect(received).toEqual([52, 52]);
    clock.advance(1000);
    expect(received).toEqual([52, 52, 52]);
  });

  it('setSpeedMultiplier after complete does not throw', () => {
    const clock = makeFakeClock();
    const fixes: ReplayFix[] = [{ coord: [52, 21], offsetMs: 0, accuracyM: 10 }];
    const handle = startGpsReplay({
      fixes,
      speedMultiplier: 8,
      clock,
      onFix: () => undefined,
      heartbeatIntervalMs: 2000,
    });
    clock.advance(0);
    expect(handle.isComplete()).toBe(true);
    handle.setSpeedMultiplier(4);
    expect(handle.getSpeedMultiplier()).toBe(4);
    clock.advance(2000);
  });
});
