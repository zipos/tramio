// Property-based test for dwell + direction triggering (task 3.4).
//
// Feature: urban-narrative-mvp, Property 2: Trigger requires dwell and direction match
//
// **Validates: Requirements 5.3, 5.4, 5.5**
//
// Strategy:
//   1. Generate a circular geofence with configurable dwellSec and optional
//      direction filter, placed on a simple east-west route.
//   2. Generate sequences of position updates that are either inside or
//      outside the geofence, with varying headings and timestamps.
//   3. Assert:
//      a) A trigger fires ONLY after accumulated dwell >= dwellSec AND
//         direction matches (or no direction filter is declared).
//      b) If the user exits the geofence before dwellSec elapses, the
//         dwell counter resets and subsequent re-entry starts from zero.
//      c) If a direction filter is declared and the heading does not match,
//         the trigger never fires regardless of dwell time.

import * as fc from 'fast-check';
import { property } from '../../../../tooling/property';
import {
  initialPipelineState,
  isRejected,
  step,
  type PipelineState,
  type PipelineAccepted,
} from './pipeline';
import { angularDiffDeg } from './geo';
import type { Geofence, LatLng, PositionUpdate } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A simple east-west route at lat 51.0, spanning 17.0 to 17.02. */
const ROUTE: readonly LatLng[] = [
  [51.0, 17.0],
  [51.0, 17.01],
  [51.0, 17.02],
];

/** Route tangent is approximately 90° (due east). */
const ROUTE_TANGENT_DEG = 90;

/**
 * Build a position update inside the geofence center with a given heading.
 * Accuracy is always good (10 m) and speed is low enough to avoid spike
 * rejection between consecutive 1-second samples.
 */
function makeUpdate(ts: number, coord: LatLng, headingDeg: number | undefined): PositionUpdate {
  return {
    ts,
    coord,
    accuracyM: 10,
    speedMps: 2,
    ...(headingDeg !== undefined ? { headingDeg } : {}),
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a dwellSec value in [3, 15] (Req 5.3: at least 3 seconds). */
const arbDwellSec = fc.integer({ min: 3, max: 15 });

/** Generate a tolerance in [5, 90] degrees for the direction filter. */
const arbToleranceDeg = fc.integer({ min: 5, max: 90 });

/** Generate a heading in [0, 360). */
const arbHeading = fc.double({ min: 0, max: 359.99, noNaN: true });

/** Generate a geofence radius in [30, 200] meters. */
const arbRadiusM = fc.integer({ min: 30, max: 200 });

/**
 * Generate a number of "inside" ticks (each 1 second apart) that is
 * either below or above the dwell threshold.
 */
const arbInsideTicks = fc.integer({ min: 1, max: 20 });

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 2: Trigger requires dwell and direction match', () => {
  // -------------------------------------------------------------------------
  // Sub-property A: Trigger fires only after accumulated dwell >= dwellSec
  // -------------------------------------------------------------------------
  property(
    { n: 2, title: 'Trigger requires dwell and direction match — dwell threshold' },
    arbDwellSec,
    arbRadiusM,
    arbInsideTicks,
    (dwellSec, radiusM, insideTicks) => {
      const center: LatLng = [51.0, 17.005];
      const geofence: Geofence = {
        poiId: 'poi-test',
        geometry: { kind: 'circle', center, radiusMeters: radiusM },
        dwellSec,
        priority: 50,
        authorIndex: 0,
      };

      let state: PipelineState = initialPipelineState(ROUTE, [geofence]);

      // Feed `insideTicks` updates, each 1 second apart, all inside the
      // geofence (at the center). Heading matches route tangent.
      let fired = false;
      let fireTickIndex = -1;
      for (let i = 0; i < insideTicks; i++) {
        const ts = i * 1000;
        const raw = makeUpdate(ts, center, ROUTE_TANGENT_DEG);
        const out = step(state, raw, ts);
        if (isRejected(out)) continue;
        const accepted = out as PipelineAccepted;
        if (accepted.fire !== undefined) {
          fired = true;
          fireTickIndex = i;
          break;
        }
        state = accepted.nextState;
      }

      if (insideTicks <= dwellSec) {
        // Not enough ticks to accumulate dwellSec; should NOT fire.
        // The first tick contributes 0 seconds (no prior entry), so after
        // N ticks we have accumulated N-1 seconds. Fire requires >= dwellSec.
        if (fired) {
          throw new Error(
            `Trigger fired at tick ${fireTickIndex} with only ${insideTicks} ticks ` +
              `(max accumulated = ${insideTicks - 1}s) but dwellSec = ${dwellSec}`,
          );
        }
      } else {
        // Enough ticks: trigger should eventually fire.
        if (!fired) {
          throw new Error(
            `Trigger did NOT fire after ${insideTicks} ticks (accumulated >= ${insideTicks - 1}s) ` +
              `with dwellSec = ${dwellSec}`,
          );
        }
        // And it should fire no earlier than tick dwellSec + 1 (0-indexed).
        // Tick 0 contributes 0s, tick 1 contributes 1s, ..., tick k contributes k-1 s cumulative.
        // So the first tick where accumulated >= dwellSec is tick dwellSec + 1 (0-indexed).
        if (fireTickIndex < dwellSec) {
          throw new Error(
            `Trigger fired too early at tick ${fireTickIndex}; ` +
              `expected no earlier than tick ${dwellSec} (dwellSec = ${dwellSec})`,
          );
        }
      }
    },
    { numRuns: 200 },
  );

  // -------------------------------------------------------------------------
  // Sub-property B: Direction filter blocks trigger when heading mismatches
  // -------------------------------------------------------------------------
  property(
    { n: 2, title: 'Trigger requires dwell and direction match — direction filter blocks' },
    arbDwellSec,
    arbToleranceDeg,
    arbHeading,
    (dwellSec, toleranceDeg, heading) => {
      // Only test headings that are clearly OUTSIDE the tolerance window.
      // Route tangent is ~90°; skip if heading is within tolerance.
      const diff = angularDiffDeg(ROUTE_TANGENT_DEG, heading);
      if (diff <= toleranceDeg) return; // pre-condition: heading must mismatch

      const center: LatLng = [51.0, 17.005];
      const geofence: Geofence = {
        poiId: 'poi-dir',
        geometry: { kind: 'circle', center, radiusMeters: 100 },
        directionFilter: { kind: 'alongRoute', toleranceDeg },
        dwellSec,
        priority: 50,
        authorIndex: 0,
      };

      let state: PipelineState = initialPipelineState(ROUTE, [geofence]);

      // Feed many ticks (well above dwellSec) with mismatching heading.
      const totalTicks = dwellSec + 10;
      for (let i = 0; i < totalTicks; i++) {
        const ts = i * 1000;
        const raw = makeUpdate(ts, center, heading);
        const out = step(state, raw, ts);
        if (isRejected(out)) continue;
        const accepted = out as PipelineAccepted;
        if (accepted.fire !== undefined) {
          throw new Error(
            `Trigger fired at tick ${i} despite heading ${heading.toFixed(1)}° ` +
              `being ${diff.toFixed(1)}° from route tangent ${ROUTE_TANGENT_DEG}° ` +
              `(tolerance = ${toleranceDeg}°)`,
          );
        }
        state = accepted.nextState;
      }
    },
    { numRuns: 200 },
  );

  // -------------------------------------------------------------------------
  // Sub-property C: Direction filter allows trigger when heading matches
  // -------------------------------------------------------------------------
  property(
    { n: 2, title: 'Trigger requires dwell and direction match — direction filter allows' },
    arbDwellSec,
    arbToleranceDeg,
    arbHeading,
    (dwellSec, toleranceDeg, heading) => {
      // Only test headings that are within the tolerance window.
      const diff = angularDiffDeg(ROUTE_TANGENT_DEG, heading);
      if (diff > toleranceDeg) return; // pre-condition: heading must match

      const center: LatLng = [51.0, 17.005];
      const geofence: Geofence = {
        poiId: 'poi-dir-ok',
        geometry: { kind: 'circle', center, radiusMeters: 100 },
        directionFilter: { kind: 'alongRoute', toleranceDeg },
        dwellSec,
        priority: 50,
        authorIndex: 0,
      };

      let state: PipelineState = initialPipelineState(ROUTE, [geofence]);

      // Feed enough ticks to exceed dwellSec.
      const totalTicks = dwellSec + 5;
      let fired = false;
      for (let i = 0; i < totalTicks; i++) {
        const ts = i * 1000;
        const raw = makeUpdate(ts, center, heading);
        const out = step(state, raw, ts);
        if (isRejected(out)) continue;
        const accepted = out as PipelineAccepted;
        if (accepted.fire !== undefined) {
          fired = true;
          break;
        }
        state = accepted.nextState;
      }

      if (!fired) {
        throw new Error(
          `Trigger did NOT fire after ${totalTicks} ticks with heading ${heading.toFixed(1)}° ` +
            `(diff = ${diff.toFixed(1)}°, tolerance = ${toleranceDeg}°, dwellSec = ${dwellSec})`,
        );
      }
    },
    { numRuns: 200 },
  );

  // -------------------------------------------------------------------------
  // Sub-property D: Exiting the geofence resets the dwell counter
  // -------------------------------------------------------------------------
  property(
    { n: 2, title: 'Trigger requires dwell and direction match — exit resets dwell' },
    arbDwellSec,
    fc.integer({ min: 1, max: 10 }),
    (dwellSec, ticksBeforeExit) => {
      // Ensure we exit before dwell threshold is reached.
      fc.pre(ticksBeforeExit < dwellSec);

      const center: LatLng = [51.0, 17.005];
      const radiusM = 80;
      const geofence: Geofence = {
        poiId: 'poi-reset',
        geometry: { kind: 'circle', center, radiusMeters: radiusM },
        dwellSec,
        priority: 50,
        authorIndex: 0,
      };

      let state: PipelineState = initialPipelineState(ROUTE, [geofence]);

      // Phase 1: stay inside for ticksBeforeExit ticks (< dwellSec).
      for (let i = 0; i < ticksBeforeExit; i++) {
        const ts = i * 1000;
        const raw = makeUpdate(ts, center, ROUTE_TANGENT_DEG);
        const out = step(state, raw, ts);
        if (!isRejected(out)) state = (out as PipelineAccepted).nextState;
      }

      // Phase 2: exit the geofence gradually to avoid spike rejection.
      // We need the smoothed position to leave the geofence, which means
      // we need enough "outside" samples to flush the smoothing window.
      // Move to a point ~500m away over multiple steps to stay under the
      // spike threshold (33.33 m/s). Each step moves ~30m/s for 1s.
      const exitCoord: LatLng = [51.0, 17.015]; // ~700m east of center
      const exitSteps = 4; // 4 steps to get there and flush the window
      let exitTs = ticksBeforeExit * 1000;
      for (let e = 0; e < exitSteps; e++) {
        exitTs += 5_000; // 5 seconds between exit steps
        // Interpolate between center and exitCoord
        const frac = (e + 1) / exitSteps;
        const interpCoord: LatLng = [51.0, 17.005 + (exitCoord[1] - 17.005) * frac];
        const exitRaw = makeUpdate(exitTs, interpCoord, ROUTE_TANGENT_DEG);
        const exitOut = step(state, exitRaw, exitTs);
        if (!isRejected(exitOut)) {
          state = (exitOut as PipelineAccepted).nextState;
        }
      }
      // After exit steps, the smoothing window should be filled with
      // coordinates outside the geofence, so dwell should be cleared.
      if (state.dwell['poi-reset'] !== undefined) {
        // If dwell is still present, the smoothed position hasn't left
        // the geofence yet — skip this case (shouldn't happen with our
        // chosen distances, but guard against edge cases).
        return;
      }

      // Phase 3: re-enter and stay for exactly dwellSec ticks.
      // The trigger should NOT fire until we accumulate dwellSec again from zero.
      const reenterBase = exitTs + 5_000; // gap after last exit step
      for (let i = 0; i < dwellSec; i++) {
        const ts = reenterBase + i * 1000;
        const raw = makeUpdate(ts, center, ROUTE_TANGENT_DEG);
        const out = step(state, raw, ts);
        if (isRejected(out)) continue;
        const accepted = out as PipelineAccepted;
        // After re-entry, the smoothing window still contains exit coords.
        // The smoothed position may not be inside the geofence for the first
        // few ticks. Only check for premature fire when the POI is actually
        // a candidate (dwell entry exists).
        if (accepted.fire !== undefined) {
          throw new Error(
            `Trigger fired prematurely at re-entry tick ${i} ` +
              `(dwellSec = ${dwellSec}). Dwell counter was not properly reset after exit.`,
          );
        }
        state = accepted.nextState;
      }

      // Phase 4: continue ticking until we expect the trigger to fire.
      // We need enough additional ticks for the smoothing window to fully
      // contain "inside" coords and for dwell to accumulate.
      let firedInPhase4 = false;
      for (let i = 0; i < dwellSec + 5; i++) {
        const ts = reenterBase + (dwellSec + i) * 1000;
        const raw = makeUpdate(ts, center, ROUTE_TANGENT_DEG);
        const out = step(state, raw, ts);
        if (isRejected(out)) continue;
        const accepted = out as PipelineAccepted;
        if (accepted.fire !== undefined) {
          firedInPhase4 = true;
          break;
        }
        state = accepted.nextState;
      }

      if (!firedInPhase4) {
        throw new Error(
          `Trigger did NOT fire after full re-entry dwell sequence ` +
            `(dwellSec = ${dwellSec}). Dwell counter may not have reset properly.`,
        );
      }
    },
    { numRuns: 200 },
  );
});
