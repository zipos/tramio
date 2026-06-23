// Property-based test for the geofence filtering pipeline (task 3.3).
//
// Feature: urban-narrative-mvp, Property 1: Geofence pipeline rejects
// low-accuracy and spike updates
//
// **Validates: Requirements 5.1, 5.2**
//
// Strategy:
//   1. Generate arbitrary PositionUpdate values with accuracyM > 50 and
//      assert the pipeline always rejects with reason 'accuracy'.
//   2. Generate pairs of updates where the implied speed exceeds 120 km/h
//      (33.33 m/s) and assert the pipeline rejects with reason 'spike'.
//   3. Generate updates with accuracy <= 50 and implied speed <= 120 km/h
//      and assert the pipeline accepts them.

import * as fc from 'fast-check';
import { property } from '../../../../tooling/property';
import {
  initialPipelineState,
  isRejected,
  step,
  MAX_ACCURACY_M,
  MAX_SPEED_MPS,
  type PipelineState,
  type PipelineAccepted,
} from './pipeline';
import { haversine } from './geo';
import type { Geofence, LatLng, PositionUpdate } from '../types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A simple east-west route for the pipeline state. */
const ROUTE: readonly LatLng[] = [
  [51.0, 17.0],
  [51.0, 17.01],
  [51.0, 17.02],
];

/** A single geofence placed far from test coords so it never fires. */
const GEOFENCES: readonly Geofence[] = [
  {
    poiId: 'poi-distant',
    geometry: { kind: 'circle', center: [51.0, 17.1], radiusMeters: 30 },
    dwellSec: 3,
    priority: 50,
    authorIndex: 0,
  },
];

function freshState(): PipelineState {
  return initialPipelineState(ROUTE, GEOFENCES);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Move a coordinate by a given distance (meters) along a bearing (degrees).
 * Uses the "destination point given distance and bearing from start point"
 * formula on a spherical Earth.
 */
function moveCoord(start: LatLng, bearingDeg: number, distM: number): LatLng {
  const R = 6_371_000;
  const lat1 = (start[0] * Math.PI) / 180;
  const lon1 = (start[1] * Math.PI) / 180;
  const brng = (bearingDeg * Math.PI) / 180;
  const angDist = distM / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2),
    );

  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary latitude in [-60, 60] (avoids poles where haversine degenerates). */
const arbLat = fc.double({ min: -60, max: 60, noNaN: true });

/** Arbitrary longitude in [-170, 170]. */
const arbLon = fc.double({ min: -170, max: 170, noNaN: true });

/** Arbitrary coordinate. */
const arbCoord: fc.Arbitrary<LatLng> = fc.tuple(arbLat, arbLon) as fc.Arbitrary<LatLng>;

/** Arbitrary accuracy that is ABOVE the threshold (> 50 m). */
const arbBadAccuracy = fc.double({ min: MAX_ACCURACY_M + 0.001, max: 10_000, noNaN: true });

/** Arbitrary accuracy that is AT or BELOW the threshold (<= 50 m). */
const arbGoodAccuracy = fc.double({ min: 0.1, max: MAX_ACCURACY_M, noNaN: true });

/** Arbitrary positive timestamp in ms. */
const arbTs = fc.integer({ min: 0, max: 2_000_000_000_000 });

/**
 * Generate a pair of updates where the second implies a speed ABOVE the
 * spike threshold relative to the first. We fix the first update's position
 * and timestamp, then compute a second position that is far enough away
 * given a short time delta to exceed MAX_SPEED_MPS.
 */
const arbSpikePair: fc.Arbitrary<{ prev: PositionUpdate; curr: PositionUpdate }> = fc
  .record({
    prevCoord: fc.tuple(
      fc.double({ min: -60, max: 60, noNaN: true }),
      fc.double({ min: -170, max: 170, noNaN: true }),
    ) as fc.Arbitrary<LatLng>,
    prevTs: fc.integer({ min: 0, max: 1_000_000_000_000 }),
    dtMs: fc.integer({ min: 100, max: 10_000 }), // 0.1s to 10s
    bearingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
    // Speed factor above the threshold: 1.5x to 10x MAX_SPEED_MPS
    speedFactor: fc.double({ min: 1.5, max: 10, noNaN: true }),
  })
  .map(({ prevCoord, prevTs, dtMs, bearingDeg, speedFactor }) => {
    const dtSec = dtMs / 1000;
    const distM = MAX_SPEED_MPS * speedFactor * dtSec;
    // Move along the bearing by distM meters
    const currCoord = moveCoord(prevCoord, bearingDeg, distM);
    const prev: PositionUpdate = {
      ts: prevTs,
      coord: prevCoord,
      accuracyM: 10,
    };
    const curr: PositionUpdate = {
      ts: prevTs + dtMs,
      coord: currCoord,
      accuracyM: 10, // good accuracy so we don't hit the accuracy gate first
    };
    return { prev, curr };
  });

/**
 * Generate a pair of updates where the second implies a speed AT or BELOW
 * the spike threshold. The update should be accepted.
 */
const arbValidPair: fc.Arbitrary<{ prev: PositionUpdate; curr: PositionUpdate }> = fc
  .record({
    prevCoord: fc.tuple(
      fc.double({ min: -60, max: 60, noNaN: true }),
      fc.double({ min: -170, max: 170, noNaN: true }),
    ) as fc.Arbitrary<LatLng>,
    prevTs: fc.integer({ min: 0, max: 1_000_000_000_000 }),
    dtMs: fc.integer({ min: 1000, max: 60_000 }), // 1s to 60s
    bearingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
    // Speed factor below the threshold: 0.01x to 0.9x MAX_SPEED_MPS
    speedFactor: fc.double({ min: 0.01, max: 0.9, noNaN: true }),
  })
  .map(({ prevCoord, prevTs, dtMs, bearingDeg, speedFactor }) => {
    const dtSec = dtMs / 1000;
    const distM = MAX_SPEED_MPS * speedFactor * dtSec;
    const currCoord = moveCoord(prevCoord, bearingDeg, distM);
    const prev: PositionUpdate = {
      ts: prevTs,
      coord: prevCoord,
      accuracyM: 10,
    };
    const curr: PositionUpdate = {
      ts: prevTs + dtMs,
      coord: currCoord,
      accuracyM: 10,
    };
    return { prev, curr };
  });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 1: Geofence pipeline rejects low-accuracy and spike updates', () => {
  // Sub-property 1: accuracy gate (Req 5.1)
  // Any update with accuracyM > 50 is rejected with reason 'accuracy'.
  property(
    { n: 1, title: 'Geofence pipeline rejects low-accuracy and spike updates' },
    arbCoord,
    arbBadAccuracy,
    arbTs,
    (coord, accuracyM, ts) => {
      const state = freshState();
      const raw: PositionUpdate = { ts, coord, accuracyM };
      const out = step(state, raw, ts);
      expect(isRejected(out)).toBe(true);
      if (isRejected(out)) {
        expect(out.reject).toBe('accuracy');
      }
    },
    { numRuns: 200 },
  );

  // Sub-property 2: spike rejection (Req 5.2)
  // Any update implying speed > 120 km/h from the previous accepted update
  // is rejected with reason 'spike'.
  it('rejects updates implying speed > 120 km/h as spike', () => {
    fc.assert(
      fc.property(arbSpikePair, ({ prev, curr }) => {
        // Seed the pipeline with the first update accepted
        let state = freshState();
        const firstOut = step(state, prev, prev.ts);
        if (isRejected(firstOut)) {
          // If the first update itself is rejected (shouldn't happen with
          // accuracyM=10 and no prev), skip this case
          return;
        }
        state = firstOut.nextState;

        // Now feed the spike update
        const out = step(state, curr, curr.ts);

        // Verify the implied speed actually exceeds the threshold
        const dtSec = (curr.ts - prev.ts) / 1000;
        const distM = haversine(prev.coord, curr.coord);
        if (dtSec > 0 && distM / dtSec > MAX_SPEED_MPS) {
          expect(isRejected(out)).toBe(true);
          if (isRejected(out)) {
            expect(out.reject).toBe('spike');
          }
        }
      }),
      { numRuns: 200, seed: 42 },
    );
  });

  // Sub-property 3: valid updates are accepted (Req 5.1, 5.2 inverse)
  // Updates with accuracy <= 50 m and implied speed <= 120 km/h are accepted.
  it('accepts updates with accuracy <= 50 m and implied speed <= 120 km/h', () => {
    fc.assert(
      fc.property(arbValidPair, ({ prev, curr }) => {
        // Seed the pipeline with the first update
        let state = freshState();
        const firstOut = step(state, prev, prev.ts);
        if (isRejected(firstOut)) {
          // Shouldn't happen with accuracyM=10 and no prev
          return;
        }
        state = firstOut.nextState;

        // Feed the valid second update
        const out = step(state, curr, curr.ts);

        // Verify the implied speed is actually below the threshold
        const dtSec = (curr.ts - prev.ts) / 1000;
        const distM = haversine(prev.coord, curr.coord);
        if (dtSec > 0 && distM / dtSec <= MAX_SPEED_MPS) {
          expect(isRejected(out)).toBe(false);
        }
      }),
      { numRuns: 200, seed: 42 },
    );
  });
});
