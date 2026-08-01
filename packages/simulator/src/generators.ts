/**
 * Deterministic trace generators.
 *
 * Generates sequences of TraceEvents from route geometry without requiring
 * large hand-written fixture files. Coordinates are interpolated along
 * geofence centers with configurable speed, dwell, accuracy, and faults.
 *
 * @module
 */

import type { LatLng, PositionUpdate } from '../../engine/src';
import { haversine } from '../../engine/src';
import type { GpsFixEvent, TraceEvent } from './trace';

// ─── Generator options ──────────────────────────────────────────────────────

export interface TraceGeneratorOptions {
  /** Average speed in m/s (default: 8 ≈ 30 km/h city bus). */
  readonly speedMps?: number;
  /** GPS fix interval in ms (default: 1000). */
  readonly fixIntervalMs?: number;
  /** Horizontal accuracy in meters (default: 10). */
  readonly accuracyM?: number;
  /** Start timestamp in ms since epoch (default: 1_700_000_000_000). */
  readonly startMs?: number;
  /** Heading simulation: if true, bearing is computed from consecutive fixes (default: true). */
  readonly simulateHeading?: boolean;
  /** Quiet tail before End Tour, allowing final narration to complete (default: 60s). */
  readonly endDelayMs?: number;
}

const DEFAULT_SPEED_MPS = 8;
const DEFAULT_FIX_INTERVAL_MS = 1000;
const DEFAULT_ACCURACY_M = 10;
const DEFAULT_START_MS = 1_700_000_000_000;

// ─── Interpolation helpers ──────────────────────────────────────────────────

/**
 * Linearly interpolate between two LatLng coordinates.
 * `t` is in [0, 1].
 */
function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Generate a sequence of coordinates along a polyline at uniform time intervals.
 * Returns coordinates at each fix interval traveling at the given speed.
 */
function interpolateAlongPolyline(
  waypoints: readonly LatLng[],
  speedMps: number,
  fixIntervalMs: number,
): LatLng[] {
  if (waypoints.length < 2) {
    return waypoints.length === 1 ? [waypoints[0]!] : [];
  }

  // Compute cumulative distance at each waypoint
  const cumDist: number[] = [0];
  for (let i = 1; i < waypoints.length; i++) {
    const prev = waypoints[i - 1]!;
    const cur = waypoints[i]!;
    cumDist.push(cumDist[i - 1]! + haversine(prev, cur));
  }

  const totalDist = cumDist[cumDist.length - 1]!;
  const distPerFix = speedMps * (fixIntervalMs / 1000);
  const numFixes = Math.ceil(totalDist / distPerFix) + 1;

  const result: LatLng[] = [];
  let segIdx = 0;

  for (let i = 0; i < numFixes; i++) {
    const distAlongRoute = Math.min(i * distPerFix, totalDist);

    // Advance segment index
    while (segIdx < waypoints.length - 2 && cumDist[segIdx + 1]! <= distAlongRoute) {
      segIdx++;
    }

    const segStart = cumDist[segIdx]!;
    const segEnd = cumDist[segIdx + 1]!;
    const segLen = segEnd - segStart;
    const t = segLen > 0 ? (distAlongRoute - segStart) / segLen : 0;

    result.push(lerp(waypoints[segIdx]!, waypoints[segIdx + 1]!, t));
  }

  return result;
}

/**
 * Compute bearing from point a to point b in degrees [0, 360).
 */
function computeBearing(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const phi1 = toRad(a[0]);
  const phi2 = toRad(b[0]);
  const dLam = toRad(b[1] - a[1]);
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// ─── Public generators ──────────────────────────────────────────────────────

/**
 * Generate a clean ride trace along a list of waypoints (typically geofence centers).
 *
 * Produces GpsFix events spaced at `fixIntervalMs` traveling at constant speed.
 * Adds a 'start' UserCommand at t=0 and an 'end' at the final fix.
 */
export function generateCleanRideTrace(
  waypoints: readonly LatLng[],
  opts: TraceGeneratorOptions = {},
): readonly TraceEvent[] {
  const speedMps = opts.speedMps ?? DEFAULT_SPEED_MPS;
  const fixIntervalMs = opts.fixIntervalMs ?? DEFAULT_FIX_INTERVAL_MS;
  const accuracyM = opts.accuracyM ?? DEFAULT_ACCURACY_M;
  const startMs = opts.startMs ?? DEFAULT_START_MS;
  const simulateHeading = opts.simulateHeading ?? true;
  const endDelayMs = opts.endDelayMs ?? 60_000;

  const coords = interpolateAlongPolyline(waypoints, speedMps, fixIntervalMs);
  const events: TraceEvent[] = [];

  // Start command at t=0
  events.push({ kind: 'UserCommand', atMs: startMs, cmd: 'start' });

  for (let i = 0; i < coords.length; i++) {
    const coord = coords[i]!;
    const atMs = startMs + i * fixIntervalMs;

    let headingDeg: number | undefined;
    if (simulateHeading && i > 0) {
      headingDeg = computeBearing(coords[i - 1]!, coord);
    }

    const fix: PositionUpdate = {
      ts: atMs,
      coord,
      accuracyM,
      speedMps,
      ...(headingDeg !== undefined ? { headingDeg } : {}),
    };

    events.push({ kind: 'GpsFix', atMs, fix });
  }

  // End command after last fix
  const lastAtMs = startMs + (coords.length - 1) * fixIntervalMs;
  events.push({ kind: 'UserCommand', atMs: lastAtMs + endDelayMs, cmd: 'end' });

  return events;
}

/**
 * Generate a trace with dwell at each waypoint.
 * The bus travels between waypoints, then sits at each for `dwellMs`.
 */
export function generateDwellTrace(
  waypoints: readonly LatLng[],
  dwellMs: number,
  opts: TraceGeneratorOptions = {},
): readonly TraceEvent[] {
  const speedMps = opts.speedMps ?? DEFAULT_SPEED_MPS;
  const fixIntervalMs = opts.fixIntervalMs ?? DEFAULT_FIX_INTERVAL_MS;
  const accuracyM = opts.accuracyM ?? DEFAULT_ACCURACY_M;
  const startMs = opts.startMs ?? DEFAULT_START_MS;
  const simulateHeading = opts.simulateHeading ?? true;
  const endDelayMs = opts.endDelayMs ?? 60_000;

  const events: TraceEvent[] = [];
  events.push({ kind: 'UserCommand', atMs: startMs, cmd: 'start' });

  let currentMs = startMs;

  for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
    const wp = waypoints[wpIdx]!;

    if (wpIdx > 0) {
      // Travel from previous waypoint to this one
      const prevWp = waypoints[wpIdx - 1]!;
      const segDist = haversine(prevWp, wp);
      const travelTime = segDist / speedMps;
      const numFixes = Math.max(1, Math.round(travelTime / (fixIntervalMs / 1000)));

      for (let i = 1; i <= numFixes; i++) {
        const t = i / numFixes;
        const coord = lerp(prevWp, wp, t);
        currentMs += fixIntervalMs;

        const fix: PositionUpdate = {
          ts: currentMs,
          coord,
          accuracyM,
          speedMps,
          ...(simulateHeading ? { headingDeg: computeBearing(prevWp, wp) } : {}),
        };
        events.push({ kind: 'GpsFix', atMs: currentMs, fix });
      }
    }

    // Dwell at waypoint
    const dwellFixes = Math.ceil(dwellMs / fixIntervalMs);
    for (let d = 0; d < dwellFixes; d++) {
      currentMs += fixIntervalMs;
      const hasHeading = simulateHeading && wpIdx < waypoints.length - 1;
      const fix: PositionUpdate = {
        ts: currentMs,
        coord: wp,
        accuracyM,
        speedMps: 0,
        ...(hasHeading ? { headingDeg: computeBearing(wp, waypoints[wpIdx + 1]!) } : {}),
      };
      events.push({ kind: 'GpsFix', atMs: currentMs, fix });
    }
  }

  events.push({ kind: 'UserCommand', atMs: currentMs + endDelayMs, cmd: 'end' });
  return events;
}

/**
 * Inject accuracy degradation into an existing trace.
 * Between `fromMs` and `toMs`, accuracy is set to `degradedAccuracyM`.
 */
export function injectAccuracyDegradation(
  trace: readonly TraceEvent[],
  fromMs: number,
  toMs: number,
  degradedAccuracyM: number,
): readonly TraceEvent[] {
  return trace.map((ev): TraceEvent => {
    if (ev.kind !== 'GpsFix') return ev;
    if (ev.atMs >= fromMs && ev.atMs <= toMs) {
      return {
        ...ev,
        fix: { ...ev.fix, accuracyM: degradedAccuracyM },
      };
    }
    return ev;
  });
}

/**
 * Inject out-of-order timestamp spike into a trace.
 * At `atMs`, insert a fix with timestamp `spikeTs` (in the past) and
 * coordinates from `spikeCoord`.
 */
export function injectTimestampSpike(
  trace: readonly TraceEvent[],
  atMs: number,
  spikeTs: number,
  spikeCoord: LatLng,
): readonly TraceEvent[] {
  const spike: GpsFixEvent = {
    kind: 'GpsFix',
    atMs,
    fix: {
      ts: spikeTs,
      coord: spikeCoord,
      accuracyM: 10,
      speedMps: 0,
    },
  };

  // Insert spike after the last event at or before `atMs`
  const result: TraceEvent[] = [];
  let inserted = false;
  for (const ev of trace) {
    if (!inserted && ev.atMs > atMs) {
      result.push(spike);
      inserted = true;
    }
    result.push(ev);
  }
  if (!inserted) result.push(spike);
  return result;
}

/**
 * Inject a location dropout: remove all GpsFix events between `fromMs` and `toMs`.
 */
export function injectLocationDropout(
  trace: readonly TraceEvent[],
  fromMs: number,
  toMs: number,
): readonly TraceEvent[] {
  return trace.filter((ev) => {
    if (ev.kind !== 'GpsFix') return true;
    return ev.atMs < fromMs || ev.atMs > toMs;
  });
}

/**
 * Create a mid-route boarding trace: starts at a specific waypoint index.
 */
export function generateMidRouteBoardingTrace(
  waypoints: readonly LatLng[],
  boardingIndex: number,
  opts: TraceGeneratorOptions = {},
): readonly TraceEvent[] {
  return generateDwellTrace(waypoints.slice(boardingIndex), 4000, opts);
}

/**
 * Generate a fast-pass trace: high speed, no dwell, reduced fix interval.
 */
export function generateFastPassTrace(
  waypoints: readonly LatLng[],
  opts: TraceGeneratorOptions = {},
): readonly TraceEvent[] {
  return generateCleanRideTrace(waypoints, {
    ...opts,
    speedMps: opts.speedMps ?? 16, // ~60 km/h
    fixIntervalMs: opts.fixIntervalMs ?? 500,
  });
}

/**
 * Generate a traffic stop trace: stops for `stopDurationMs` at a given waypoint index.
 */
export function generateTrafficStopTrace(
  waypoints: readonly LatLng[],
  stopAtIndex: number,
  stopDurationMs: number,
  opts: TraceGeneratorOptions = {},
): readonly TraceEvent[] {
  // Split into pre-stop, dwell at stop, post-stop
  const pre = waypoints.slice(0, stopAtIndex + 1);
  const post = waypoints.slice(stopAtIndex);

  const speedMps = opts.speedMps ?? DEFAULT_SPEED_MPS;
  const fixIntervalMs = opts.fixIntervalMs ?? DEFAULT_FIX_INTERVAL_MS;
  const accuracyM = opts.accuracyM ?? DEFAULT_ACCURACY_M;
  const startMs = opts.startMs ?? DEFAULT_START_MS;
  const endDelayMs = opts.endDelayMs ?? 60_000;

  const events: TraceEvent[] = [];
  events.push({ kind: 'UserCommand', atMs: startMs, cmd: 'start' });

  // Travel to stop
  const preCoords = interpolateAlongPolyline(pre, speedMps, fixIntervalMs);
  let currentMs = startMs;
  for (let i = 0; i < preCoords.length; i++) {
    currentMs = startMs + i * fixIntervalMs;
    const coord = preCoords[i]!;
    const fix: PositionUpdate = {
      ts: currentMs,
      coord,
      accuracyM,
      speedMps: i === preCoords.length - 1 ? 0 : speedMps,
    };
    events.push({ kind: 'GpsFix', atMs: currentMs, fix });
  }

  // Dwell at traffic stop
  const stopCoord = waypoints[stopAtIndex]!;
  const dwellFixes = Math.ceil(stopDurationMs / fixIntervalMs);
  for (let d = 0; d < dwellFixes; d++) {
    currentMs += fixIntervalMs;
    const fix: PositionUpdate = {
      ts: currentMs,
      coord: stopCoord,
      accuracyM,
      speedMps: 0,
    };
    events.push({ kind: 'GpsFix', atMs: currentMs, fix });
  }

  // Continue after stop
  const postCoords = interpolateAlongPolyline(post, speedMps, fixIntervalMs);
  for (let i = 1; i < postCoords.length; i++) {
    currentMs += fixIntervalMs;
    const coord = postCoords[i]!;
    const fix: PositionUpdate = {
      ts: currentMs,
      coord,
      accuracyM,
      speedMps,
    };
    events.push({ kind: 'GpsFix', atMs: currentMs, fix });
  }

  events.push({ kind: 'UserCommand', atMs: currentMs + endDelayMs, cmd: 'end' });
  return events;
}

/**
 * Inject focus interruption and regain into a trace.
 */
export function injectFocusInterruption(
  trace: readonly TraceEvent[],
  lossAtMs: number,
  regainAtMs: number,
): readonly TraceEvent[] {
  const result: TraceEvent[] = [];
  let lossInserted = false;
  let regainInserted = false;

  for (const ev of trace) {
    if (!lossInserted && ev.atMs >= lossAtMs) {
      result.push({ kind: 'AppBackground', atMs: lossAtMs });
      lossInserted = true;
    }
    if (!regainInserted && ev.atMs >= regainAtMs) {
      result.push({ kind: 'AppForeground', atMs: regainAtMs });
      regainInserted = true;
    }
    result.push(ev);
  }

  if (!lossInserted) result.push({ kind: 'AppBackground', atMs: lossAtMs });
  if (!regainInserted) result.push({ kind: 'AppForeground', atMs: regainAtMs });
  return result;
}
