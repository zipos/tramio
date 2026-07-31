// Unit tests for the geofence filtering pipeline.
//
// Property tests for the universal P1 (accuracy/spike) and P2 (dwell +
// direction) shapes are tasks 3.3 and 3.4. These are the directed,
// example-based tests that verify each stage in isolation against
// representative inputs.
//
// @see design.md "## Geofence Filtering Pipeline"

import {
  MAX_ACCURACY_M,
  MAX_SPEED_MPS,
  SMOOTH_WINDOW,
  initialPipelineState,
  isRejected,
  prefilter,
  step,
  type PipelineState,
  type PipelineAccepted,
} from './pipeline';
import type { Geofence, LatLng, PositionUpdate } from '../types';

const ROUTE: readonly LatLng[] = [
  [51.0, 17.0],
  [51.0, 17.01],
  [51.0, 17.02],
];

function rawAt(ts: number, coord: LatLng, overrides: Partial<PositionUpdate> = {}): PositionUpdate {
  return {
    ts,
    coord,
    accuracyM: 10,
    headingDeg: 90, // due east, matches ROUTE tangent
    speedMps: 5,
    ...overrides,
  };
}

function expectAccepted(out: ReturnType<typeof step>): PipelineAccepted {
  if (isRejected(out)) {
    throw new Error(`expected acceptance, got rejection: ${out.reject}`);
  }
  return out;
}

describe('prefilter (Stages 1 + 2)', () => {
  it('rejects updates whose accuracy exceeds 50 m', () => {
    const r = prefilter(rawAt(0, [51, 17], { accuracyM: MAX_ACCURACY_M + 0.1 }), undefined);
    expect(r).toBe('accuracy');
  });

  it('accepts updates exactly at the accuracy threshold', () => {
    const r = prefilter(rawAt(0, [51, 17], { accuracyM: MAX_ACCURACY_M }), undefined);
    expect(r).toBeNull();
  });

  it('rejects spikes implying speed > 120 km/h', () => {
    const prev = rawAt(0, [51, 17]);
    // ~2 km in 10 s = 200 m/s, well above 33.33 m/s.
    const next = rawAt(10_000, [51.018, 17]);
    expect(prefilter(next, prev)).toBe('spike');
  });

  it('does not reject when implied speed is exactly at the limit', () => {
    const prev = rawAt(0, [0, 0]);
    // Move just under MAX_SPEED_MPS over 1 s.
    const distM = MAX_SPEED_MPS - 0.001;
    const dLat = distM / 111_320; // ~ meters per deg lat at the equator
    const next = rawAt(1_000, [dLat, 0]);
    expect(prefilter(next, prev)).toBeNull();
  });

  it('passes when there is no previous accepted update', () => {
    expect(prefilter(rawAt(0, [51, 17]), undefined)).toBeNull();
  });

  it('rejects as spike when dt is zero and displacement exceeds tolerance', () => {
    const prev = rawAt(0, [51, 17]);
    // ~131 m displacement with dt=0 is physically impossible — spike.
    const next = rawAt(0, [51.001, 17.001]);
    expect(prefilter(next, prev)).toBe('spike');
  });

  it('passes when dt is zero and displacement is within jitter tolerance (<=5 m)', () => {
    const prev = rawAt(0, [51, 17]);
    // ~0.00003 deg lat ≈ 3.3 m — within the 5 m jitter tolerance.
    const next = rawAt(0, [51.00003, 17]);
    expect(prefilter(next, prev)).toBeNull();
  });
});

describe('step', () => {
  const geofences: readonly Geofence[] = [
    {
      poiId: 'poi-rynek',
      geometry: { kind: 'circle', center: [51.0, 17.005], radiusMeters: 80 },
      directionFilter: { kind: 'alongRoute', toleranceDeg: 30 },
      dwellSec: 3,
      priority: 90,
      authorIndex: 0,
    },
  ];

  function freshState(): PipelineState {
    return initialPipelineState(ROUTE, geofences);
  }

  it('rejects an update with bad accuracy and leaves state unchanged', () => {
    const s0 = freshState();
    const out = step(s0, rawAt(0, [51, 17], { accuracyM: 100 }), 0);
    expect(isRejected(out)).toBe(true);
    if (isRejected(out)) {
      expect(out.reject).toBe('accuracy');
      expect(out.nextState).toBe(s0);
    }
  });

  it('emits a smoothed coord that is the mean of the window', () => {
    // 0.0001 deg lon at lat 51 is ~ 7 m, well below the spike threshold over
    // a 1 s interval (limit is ~ 33 m/s).
    let s = freshState();
    const r1 = expectAccepted(step(s, rawAt(0, [51.0, 17.0]), 0));
    s = r1.nextState;
    const r2 = expectAccepted(step(s, rawAt(1_000, [51.0, 17.0001]), 1_000));
    s = r2.nextState;
    const r3 = expectAccepted(step(s, rawAt(2_000, [51.0, 17.0002]), 2_000));

    expect(r1.accepted.smoothed).toEqual([51.0, 17.0]);
    expect(r2.accepted.smoothed[1]).toBeCloseTo(17.00005, 7);
    // Mean of three: (0 + 0.0001 + 0.0002) / 3 = 0.0001
    expect(r3.accepted.smoothed[1]).toBeCloseTo(17.0001, 7);
  });

  it('caps the smoothing window at SMOOTH_WINDOW samples', () => {
    let s = freshState();
    for (let i = 0; i < SMOOTH_WINDOW + 5; i++) {
      const out = step(s, rawAt(i * 1000, [51.0, 17.0 + i * 0.0001]), i * 1000);
      s = expectAccepted(out).nextState;
    }
    expect(s.smoothingWindow.length).toBe(SMOOTH_WINDOW);
  });

  it('produces a monotonic alongRouteM for points walking the polyline', () => {
    let s = freshState();
    // Step ~ 1.4 m east per second; well within the spike limit.
    const samples: LatLng[] = [
      [51.0, 17.0],
      [51.0, 17.00002],
      [51.0, 17.00004],
      [51.0, 17.00006],
      [51.0, 17.00008],
    ];
    let prev = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      const out = expectAccepted(step(s, rawAt(i * 1000, samples[i] as LatLng), i * 1000));
      expect(out.accepted.alongRouteM).toBeGreaterThanOrEqual(prev);
      prev = out.accepted.alongRouteM;
      s = out.nextState;
    }
  });

  it('fires only after dwellSec of continuous presence', () => {
    let s = freshState();
    // Sample at t=0 inside the geofence; dwell starts at 0 (no prior tick).
    const r0 = expectAccepted(step(s, rawAt(0, [51.0, 17.005]), 0));
    expect(r0.fire).toBeUndefined();
    expect(r0.nextState.dwell['poi-rynek']?.accumulatedSec).toBe(0);
    s = r0.nextState;

    // 2 s later: accumulator advances to 2 s; still below dwellSec=3.
    const r1 = expectAccepted(step(s, rawAt(2_000, [51.0, 17.005]), 2_000));
    expect(r1.fire).toBeUndefined();
    expect(r1.nextState.dwell['poi-rynek']?.accumulatedSec).toBe(2);
    s = r1.nextState;

    // Another 2 s: total 4 s >= 3 s, direction matches, fire.
    const r2 = expectAccepted(step(s, rawAt(4_000, [51.0, 17.005]), 4_000));
    expect(r2.fire).toBe('poi-rynek');
  });

  it('resets the dwell accumulator when the POI drops out of candidates', () => {
    let s = freshState();
    s = expectAccepted(step(s, rawAt(0, [51.0, 17.005]), 0)).nextState;
    s = expectAccepted(step(s, rawAt(2_000, [51.0, 17.005]), 2_000)).nextState;
    expect(s.dwell['poi-rynek']?.accumulatedSec).toBe(2);

    // Step out of the geofence over a 100 s interval so the implied speed
    // (~ 31 m/s) stays just under the spike threshold.
    s = expectAccepted(step(s, rawAt(102_000, [51.0, 17.05]), 102_000)).nextState;
    expect(s.dwell['poi-rynek']).toBeUndefined();
  });

  it('does not fire when the direction filter rejects the heading', () => {
    let s = freshState();
    // Heading 270 (due west) opposes the route tangent of ~ 90 (due east).
    s = expectAccepted(step(s, rawAt(0, [51.0, 17.005], { headingDeg: 270 }), 0)).nextState;
    s = expectAccepted(step(s, rawAt(2_000, [51.0, 17.005], { headingDeg: 270 }), 2_000)).nextState;
    const r = expectAccepted(step(s, rawAt(4_000, [51.0, 17.005], { headingDeg: 270 }), 4_000));
    expect(r.fire).toBeUndefined();
  });

  it('does not fire for a POI listed in the consumed set', () => {
    const consumed = new Set<string>(['poi-rynek']);
    let s = initialPipelineState(ROUTE, geofences, consumed);
    s = expectAccepted(step(s, rawAt(0, [51.0, 17.005]), 0)).nextState;
    s = expectAccepted(step(s, rawAt(2_000, [51.0, 17.005]), 2_000)).nextState;
    const r = expectAccepted(step(s, rawAt(4_000, [51.0, 17.005]), 4_000));
    expect(r.fire).toBeUndefined();
    // And the dwell accumulator never grows for consumed POIs.
    expect(r.nextState.dwell['poi-rynek']).toBeUndefined();
  });

  it('still rejects spikes after a previously-accepted update', () => {
    let s = freshState();
    s = expectAccepted(step(s, rawAt(0, [51.0, 17.0]), 0)).nextState;
    // 200 m/s for 1 s = 200 m, well above MAX_SPEED_MPS.
    const out = step(s, rawAt(1_000, [51.002, 17.0]), 1_000);
    expect(isRejected(out)).toBe(true);
    if (isRejected(out)) {
      expect(out.reject).toBe('spike');
    }
  });

  it('does not mutate the input state object', () => {
    const s0 = freshState();
    const snapshot = JSON.stringify({
      smoothingWindow: s0.smoothingWindow,
      dwell: s0.dwell,
      lastAccepted: s0.lastAccepted ?? null,
    });
    step(s0, rawAt(0, [51.0, 17.005]), 0);
    expect(
      JSON.stringify({
        smoothingWindow: s0.smoothingWindow,
        dwell: s0.dwell,
        lastAccepted: s0.lastAccepted ?? null,
      }),
    ).toBe(snapshot);
  });
});

// ─── FIX 1: Non-increasing timestamp spike rejection ────────────────────────

describe('FIX 1: prefilter rejects large displacements on non-increasing timestamps', () => {
  it('rejects out-of-order timestamp with large displacement (Android batch fix)', () => {
    // Concrete case from the bug report: ts=1000 coord=A then ts=999 coord=B
    // where B is 5 km away — physically impossible.
    const prev = rawAt(1000, [51.0, 17.0]);
    const curr = rawAt(999, [51.045, 17.0]); // ~5 km away, ts < prev.ts
    expect(prefilter(curr, prev)).toBe('spike');
  });

  it('rejects equal-timestamp fix with large displacement', () => {
    const prev = rawAt(5000, [51.0, 17.0]);
    const curr = rawAt(5000, [51.01, 17.0]); // ~1.1 km away
    expect(prefilter(curr, prev)).toBe('spike');
  });

  it('accepts equal-timestamp fix with small displacement (GPS jitter)', () => {
    const prev = rawAt(5000, [51.0, 17.0]);
    // ~3 m displacement — within the 5 m jitter tolerance
    const curr = rawAt(5000, [51.000027, 17.0]);
    expect(prefilter(curr, prev)).toBeNull();
  });

  it('accepts out-of-order timestamp with small displacement (GPS jitter)', () => {
    const prev = rawAt(5000, [51.0, 17.0]);
    // ~4 m displacement with earlier timestamp — jitter tolerance applies
    const curr = rawAt(4999, [51.000036, 17.0]);
    expect(prefilter(curr, prev)).toBeNull();
  });

  it('rejects displacement just over the 5 m tolerance at equal timestamp', () => {
    const prev = rawAt(5000, [51.0, 17.0]);
    // ~6.7 m displacement (0.00006 deg lat * 111320 m/deg ≈ 6.68 m) — over 5 m
    const curr = rawAt(5000, [51.00006, 17.0]);
    expect(prefilter(curr, prev)).toBe('spike');
  });

  it('does not affect the strictly-increasing timestamp path', () => {
    // Normal case: strictly increasing timestamps use speed-based check
    const prev = rawAt(0, [51.0, 17.0]);
    // 33 m in 1 s = 33 m/s — just under the 33.33 m/s (120 km/h) limit
    const dLat = 33 / 111_320;
    const curr = rawAt(1000, [51.0 + dLat, 17.0]);
    expect(prefilter(curr, prev)).toBeNull();
  });
});

describe('FIX 1: pipeline step rejects out-of-order timestamps with large displacement', () => {
  const geofences: readonly Geofence[] = [
    {
      poiId: 'poi-rynek',
      geometry: { kind: 'circle', center: [51.0, 17.005], radiusMeters: 80 },
      dwellSec: 3,
      priority: 90,
      authorIndex: 0,
    },
  ];

  it('spurious almanac fix at ts-1 with 5km displacement is rejected by pipeline', () => {
    let s = initialPipelineState(ROUTE, geofences);
    // First fix accepted normally
    const r0 = step(s, rawAt(1000, [51.0, 17.0]), 1000);
    expect(isRejected(r0)).toBe(false);
    s = (r0 as PipelineAccepted).nextState;

    // Android batch: arrives with ts=999 (before prev) and 5 km displacement
    const spurious = rawAt(999, [51.045, 17.0]);
    const r1 = step(s, spurious, 999);
    expect(isRejected(r1)).toBe(true);
    if (isRejected(r1)) {
      expect(r1.reject).toBe('spike');
    }
  });

  it('rejected fix does not enter the EMA smoothing window', () => {
    let s = initialPipelineState(ROUTE, geofences);
    const r0 = step(s, rawAt(1000, [51.0, 17.005]), 1000);
    expect(isRejected(r0)).toBe(false);
    s = (r0 as PipelineAccepted).nextState;
    expect(s.smoothingWindow).toHaveLength(1);

    // Spurious fix rejected
    const r1 = step(s, rawAt(999, [51.045, 17.0]), 999);
    expect(isRejected(r1)).toBe(true);
    // Window unchanged
    expect(r1.nextState.smoothingWindow).toHaveLength(1);
    expect(r1.nextState.smoothingWindow[0]).toEqual([51.0, 17.005]);
  });
});
