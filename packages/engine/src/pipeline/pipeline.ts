// Geofence filtering pipeline.
//
// Implements the five-stage pipeline described in design.md
// "## Geofence Filtering Pipeline":
//
//   1. Accuracy gate    (native-callable; reject if accuracyM > 50)
//   2. Spike rejection  (native-callable; reject if implied speed > 120 km/h)
//   3. EMA smoothing    (JS; over the last 3 accepted updates)
//   4. Dwell accumulator (JS; per-candidate-POI continuous-presence timer)
//   5. Direction filter (JS; projected route tangent vs heading)
//
// The pipeline state is a pure value: every transition produces a new
// state, no class instances or hidden mutability. This keeps the reducer
// property-testable (P1, P2, P18) and lets Stages 1-2 be lifted to the
// native side via the same TypeScript interface (`prefilter`).
//
// @see design.md "## Geofence Filtering Pipeline"
// @see Requirements 5.1, 5.2, 5.3, 5.4, 5.5

import type { AcceptedUpdate, Geofence, LatLng, PositionUpdate } from '../types';
import { angularDiffDeg, haversine, pointInCircle, pointInPolygon, projectOnRoute } from './geo';

/** Maximum accepted horizontal accuracy, in meters (Req 5.1). */
export const MAX_ACCURACY_M = 50;

/** Maximum plausible ground speed for transit, in m/s (Req 5.2; 120 km/h). */
export const MAX_SPEED_MPS = 120 / 3.6;

/** Window length over which EMA smoothing is computed (Req 5.5). */
export const SMOOTH_WINDOW = 3;

/**
 * Reason returned by Stages 1-2 when a raw update is rejected. Exposed so
 * the native side and the JS side classify rejections identically.
 */
export type PrefilterReject = 'accuracy' | 'spike';

/**
 * Per-POI dwell accumulator. We track both the running total of continuous
 * presence and the timestamp of the most recent accepted update that saw
 * the POI as a candidate so successive updates can compute their own dt.
 */
export interface DwellEntry {
  readonly accumulatedSec: number;
  readonly lastSeenTs: number;
}

/**
 * Pipeline state value. The reducer stores this on `TourSession` (or wraps
 * the engine in a state-transition shell that does); here it is exposed as
 * a standalone shape so unit and property tests can drive it directly.
 */
export interface PipelineState {
  /** Active route polyline. Required for Stage 5 (direction filter). */
  readonly route: readonly LatLng[];
  /** Geofences armed for this session. Required for Stage 4 candidate set. */
  readonly geofences: readonly Geofence[];
  /**
   * Last accepted (post-Stage 1-2) raw update. Drives Stage 2 (need a
   * `prev`) and the EMA window. The most recent N=3 raw coords used for
   * smoothing are tracked separately in `smoothingWindow` below.
   */
  readonly lastAccepted?: PositionUpdate;
  /**
   * Last AcceptedUpdate emitted by the pipeline (after Stages 1-5 but
   * specifically including smoothing and projection). Available to the
   * reducer so it can fall back to "last known position" when it enters
   * Dead_Reckoning, and so it can compare consecutive smoothed positions
   * for the deviation/standby checks.
   */
  readonly lastEmitted?: AcceptedUpdate;
  /**
   * Coordinates of up to the last `SMOOTH_WINDOW` accepted raw updates,
   * oldest first. The smoothed coordinate emitted alongside an accepted
   * update is the EMA over this window after the new coord has been
   * appended (and any stale coord dropped).
   */
  readonly smoothingWindow: readonly LatLng[];
  /** Per-POI dwell accumulator. Reset when a POI is no longer a candidate. */
  readonly dwell: Readonly<Record<string, DwellEntry>>;
  /**
   * POIs already fired at least once in this session. The reducer is the
   * source of truth for "consumed", but the pipeline short-circuits before
   * Stage 4 for POIs in this set so we never re-trigger one (Req 1.5).
   */
  readonly consumed: ReadonlySet<string>;
}

/** Output of `step` on success: an accepted update plus an optional fired POI. */
export interface PipelineAccepted {
  readonly accepted: AcceptedUpdate;
  /** POI id whose dwell + direction conditions just fired, if any. */
  readonly fire?: string;
  readonly nextState: PipelineState;
}

/** Output of `step` on rejection: no `accepted`, only the reason and next state. */
export interface PipelineRejected {
  readonly reject: PrefilterReject;
  readonly nextState: PipelineState;
}

export type PipelineOutput = PipelineAccepted | PipelineRejected;

/** Type-narrowing helper: `true` when the update was rejected. */
export function isRejected(o: PipelineOutput): o is PipelineRejected {
  return (o as PipelineRejected).reject !== undefined;
}

/**
 * Stages 1 and 2 in isolation. Pure: takes the candidate update plus the
 * previous accepted raw update (for the spike calculation) and returns
 * either a rejection reason or `null` to indicate the update passed.
 *
 * This is the function the eventual native side calls through the same TS
 * interface (task description: "parallel native interface"). Because both
 * sides agree on the predicate verbatim, a native rejection reason can be
 * forwarded as `EngineEvent.kind === 'LocationRejected'` without the JS
 * reducer needing to know whether the filter ran on-device or in JS.
 */
export function prefilter(
  raw: PositionUpdate,
  prevAccepted: PositionUpdate | undefined,
): PrefilterReject | null {
  if (raw.accuracyM > MAX_ACCURACY_M) return 'accuracy';
  if (prevAccepted) {
    const dtSec = (raw.ts - prevAccepted.ts) / 1000;
    if (dtSec > 0) {
      const distM = haversine(prevAccepted.coord, raw.coord);
      if (distM / dtSec > MAX_SPEED_MPS) return 'spike';
    }
  }
  return null;
}

/**
 * Build the initial pipeline state for a session. The route and geofence
 * list are immutable for the life of the session; the reducer regenerates
 * the state when the user starts a new tour.
 */
export function initialPipelineState(
  route: readonly LatLng[],
  geofences: readonly Geofence[],
  consumed: ReadonlySet<string> = new Set(),
): PipelineState {
  return {
    route,
    geofences,
    smoothingWindow: [],
    dwell: {},
    consumed,
  };
}

/**
 * Equal-weight EMA over the smoothing window. We use the arithmetic mean
 * over up to `SMOOTH_WINDOW` recent coords rather than a recency-biased
 * EMA: with N=3 the difference is small, the arithmetic mean has the nice
 * property that it never overshoots the input range, and Req 5.5 only
 * specifies "smoothed position estimate using at least the last 3 accepted
 * updates" without prescribing the weighting.
 */
function smoothCoord(window: readonly LatLng[]): LatLng {
  if (window.length === 0) {
    throw new Error('smoothCoord: window must be non-empty');
  }
  let latSum = 0;
  let lonSum = 0;
  for (const c of window) {
    latSum += c[0];
    lonSum += c[1];
  }
  return [latSum / window.length, lonSum / window.length];
}

function pushWindow(window: readonly LatLng[], coord: LatLng): readonly LatLng[] {
  const next = window.length < SMOOTH_WINDOW ? [...window, coord] : [...window.slice(1), coord];
  return next;
}

function geofenceContains(g: Geofence, coord: LatLng): boolean {
  if (g.geometry.kind === 'circle') {
    return pointInCircle(coord, g.geometry.center, g.geometry.radiusMeters);
  }
  return pointInPolygon(g.geometry.vertices, coord);
}

function directionMatches(
  geofence: Geofence,
  tangentDeg: number,
  headingDeg: number | undefined,
): boolean {
  const filter = geofence.directionFilter;
  if (!filter) return true; // no filter declared => always matches
  if (headingDeg === undefined) return false; // filter declared, no heading => can't satisfy
  return angularDiffDeg(tangentDeg, headingDeg) <= filter.toleranceDeg;
}

/**
 * Advance the pipeline by one raw update.
 *
 * Stages applied in order:
 *   1. Accuracy gate      — Req 5.1
 *   2. Spike rejection    — Req 5.2
 *   3. EMA smoothing      — Req 5.5
 *   4. Dwell accumulator  — Req 5.3
 *   5. Direction filter   — Req 5.4
 *
 * Returns either a rejection (with `reject` carrying the stage 1/2 reason
 * and `nextState` left functionally untouched) or an accepted update. When
 * the dwell + direction conditions are satisfied for a candidate POI, the
 * matching `poiId` is reported in `fire`. Already-consumed POIs short-
 * circuit before Stage 4 (per design.md note: "A POI fires at most once
 * per session... short-circuits before stage 4").
 *
 * The `ts` parameter is the wall-clock instant of `raw`; we accept it
 * separately so the reducer can pass a clock-driven instant when the
 * update itself does not carry one (e.g. when synthesizing test data).
 * In production it should match `raw.ts`.
 */
export function step(state: PipelineState, raw: PositionUpdate, ts: number): PipelineOutput {
  // Stages 1 + 2 (also exposed standalone via `prefilter`).
  const rejection = prefilter(raw, state.lastAccepted);
  if (rejection !== null) {
    return { reject: rejection, nextState: state };
  }

  // Stage 3: append to the smoothing window and compute EMA.
  const nextWindow = pushWindow(state.smoothingWindow, raw.coord);
  const smoothed = smoothCoord(nextWindow);

  // Project smoothed coord onto the active route.
  const projection = projectOnRoute(state.route, smoothed);

  const accepted: AcceptedUpdate = {
    ...raw,
    smoothed,
    alongRouteM: projection.alongRouteM,
  };

  // Stage 4: dwell accumulator. A POI is a "candidate" when its geometry
  // contains the smoothed coord; the running total advances by the gap
  // since the last accepted update that saw it as a candidate, and resets
  // to zero whenever the POI drops out.
  const candidates: Geofence[] = [];
  for (const g of state.geofences) {
    if (state.consumed.has(g.poiId)) continue; // short-circuit before stage 4
    if (geofenceContains(g, smoothed)) candidates.push(g);
  }

  const nextDwell: Record<string, DwellEntry> = {};
  let fire: string | undefined;
  for (const g of candidates) {
    const prev = state.dwell[g.poiId];
    const dt = prev ? Math.max(0, (ts - prev.lastSeenTs) / 1000) : 0;
    const accumulated = (prev ? prev.accumulatedSec : 0) + dt;
    nextDwell[g.poiId] = { accumulatedSec: accumulated, lastSeenTs: ts };

    // Stage 5: direction filter against the route tangent at projection.
    if (
      fire === undefined &&
      accumulated >= g.dwellSec &&
      directionMatches(g, projection.tangentDeg, raw.headingDeg)
    ) {
      fire = g.poiId;
    }
  }
  // POIs that dropped out of the candidate set lose their accumulator.
  // (We just don't carry them forward in `nextDwell`.)

  const nextState: PipelineState = {
    ...state,
    lastAccepted: raw,
    lastEmitted: accepted,
    smoothingWindow: nextWindow,
    dwell: nextDwell,
  };

  return fire !== undefined ? { accepted, fire, nextState } : { accepted, nextState };
}
