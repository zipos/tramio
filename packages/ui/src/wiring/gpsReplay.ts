// gpsReplay — wall-clock GPS injection for desk testing (__DEV__).
//
// Features:
//   - Catch-up batches so high trip speeds (8x) do not stall the timer chain
//   - seekToCoord so "Next POI" advances the rider on the map, not only audio
//   - Heartbeat after the trace ends so UI does not flip to "Acquiring GPS…"

import type { LatLng } from '../../../engine/src';
import { haversine } from '../../../engine/src';

export interface ReplayFix {
  readonly coord: LatLng;
  /** Relative ms from replay start (monotone non-decreasing). */
  readonly offsetMs: number;
  readonly accuracyM: number;
  readonly speedMps?: number;
  readonly headingDeg?: number;
}

export type ReplayLocationObject = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    altitude: null;
    altitudeAccuracy: null;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
};

export interface GpsReplayHandle {
  stop(): void;
  getSpeedMultiplier(): number;
  setSpeedMultiplier(mult: number): void;
  /** Jump the cursor to the first fix within radiusM of target; emit it now. */
  seekToCoord(target: LatLng, radiusM?: number): boolean;
  isComplete(): boolean;
  getLastCoord(): LatLng | null;
}

export interface GpsReplayClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StartGpsReplayOptions {
  readonly fixes: readonly ReplayFix[];
  readonly speedMultiplier?: number;
  readonly clock?: GpsReplayClock;
  readonly onFix: (fix: ReplayLocationObject) => void;
  readonly onComplete?: () => void;
  readonly onSpeedChange?: (mult: number) => void;
  /** Keep last fix alive after the trace ends (default 2000 ms). 0 = off. */
  readonly heartbeatIntervalMs?: number;
}

const DEFAULT_SPEED_MULTIPLIER = 4;
const DEFAULT_HEARTBEAT_MS = 2_000;
/** Max overdue fixes emitted in one catch-up turn (keeps the JS thread free). */
const CATCH_UP_BATCH = 40;

export function startGpsReplay(options: StartGpsReplayOptions): GpsReplayHandle {
  const clock: GpsReplayClock = options.clock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const fixes = options.fixes;

  let speed = Math.max(0.25, options.speedMultiplier ?? DEFAULT_SPEED_MULTIPLIER);
  let baseWall = clock.now();
  let index = 0;
  let timer: unknown = null;
  let heartbeatTimer: unknown = null;
  let stopped = false;
  let complete = false;
  let lastFix: ReplayFix | null = fixes[0] ?? null;

  const clearSchedule = (): void => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  };

  const clearHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clock.clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const emitFix = (fix: ReplayFix, opts?: { heartbeat?: boolean }): void => {
    lastFix = fix;
    // Fix timestamp passed to the location object (which feeds the geofence pipeline)
    // MUST reflect the vehicle's simulated trajectory time (`baseWall + fix.offsetMs`),
    // NOT wall time divided by speed (`baseWall + fix.offsetMs / speed`).
    // Dividing by speed compresses trace-time dt by speed-multiplier (e.g. 8x), causing
    // the pipeline's speed gate (>120 km/h) to misclassify normal vehicle motion as a spike.
    const timestamp = opts?.heartbeat ? clock.now() : Math.round(baseWall + fix.offsetMs);

    options.onFix({
      coords: {
        latitude: fix.coord[0],
        longitude: fix.coord[1],
        accuracy: fix.accuracyM,
        altitude: null,
        altitudeAccuracy: null,
        heading: fix.headingDeg ?? null,
        speed: fix.speedMps ?? null,
      },
      timestamp,
    });
  };

  const armHeartbeat = (): void => {
    clearHeartbeat();
    if (heartbeatMs <= 0 || lastFix === null || stopped) return;
    const beat = (): void => {
      if (stopped || !complete || lastFix === null) return;
      emitFix(lastFix, { heartbeat: true });
      heartbeatTimer = clock.setTimeout(beat, heartbeatMs);
    };
    heartbeatTimer = clock.setTimeout(beat, heartbeatMs);
  };

  const markComplete = (): void => {
    if (complete) {
      armHeartbeat();
      return;
    }
    complete = true;
    options.onComplete?.();
    armHeartbeat();
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    clearSchedule();

    if (index >= fixes.length) {
      markComplete();
      return;
    }

    const now = clock.now();
    let batch = 0;
    while (index < fixes.length && batch < CATCH_UP_BATCH) {
      const fix = fixes[index]!;
      const dueWall = baseWall + fix.offsetMs / speed;
      if (dueWall > now) break;
      emitFix(fix);
      index += 1;
      batch += 1;
    }

    if (index >= fixes.length) {
      markComplete();
      return;
    }

    // More overdue fixes remain — yield then continue catch-up.
    if (batch >= CATCH_UP_BATCH) {
      timer = clock.setTimeout(() => {
        timer = null;
        scheduleNext();
      }, 0);
      return;
    }

    const fix = fixes[index]!;
    const dueWall = baseWall + fix.offsetMs / speed;
    timer = clock.setTimeout(
      () => {
        timer = null;
        scheduleNext();
      },
      Math.max(0, dueWall - clock.now()),
    );
  };

  scheduleNext();

  return {
    stop() {
      stopped = true;
      clearSchedule();
      clearHeartbeat();
    },
    getSpeedMultiplier() {
      return speed;
    },
    setSpeedMultiplier(mult: number) {
      if (stopped) return;
      const next = Math.max(0.25, mult);
      if (next === speed) return;
      const now = clock.now();
      const tracePosMs = (now - baseWall) * speed;
      speed = next;
      baseWall = now - tracePosMs / speed;
      options.onSpeedChange?.(speed);
      if (!complete) {
        scheduleNext();
      }
      // If complete, heartbeat keeps lastFix alive; speed only matters after seek.
    },
    seekToCoord(target: LatLng, radiusM = 50): boolean {
      if (stopped || fixes.length === 0) return false;

      let found = -1;
      // Prefer forward seek from the current cursor, then full scan.
      for (let i = index; i < fixes.length; i++) {
        if (haversine(fixes[i]!.coord, target) <= radiusM) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        for (let i = 0; i < fixes.length; i++) {
          if (haversine(fixes[i]!.coord, target) <= radiusM) {
            found = i;
            break;
          }
        }
      }
      if (found < 0) return false;

      clearSchedule();
      clearHeartbeat();
      complete = false;
      index = found;
      baseWall = clock.now() - fixes[found]!.offsetMs / speed;
      emitFix(fixes[found]!);
      index = found + 1;
      scheduleNext();
      return true;
    },
    isComplete() {
      return complete;
    },
    getLastCoord() {
      return lastFix?.coord ?? null;
    },
  };
}

export interface DeskTraceOptions {
  readonly waypoints: readonly LatLng[];
  readonly speedMps?: number;
  readonly fixIntervalMs?: number;
  readonly accuracyM?: number;
  readonly dwellMs?: number;
}

export function buildDeskTrace(options: DeskTraceOptions): ReplayFix[] {
  const speedMps = options.speedMps ?? 8;
  const fixIntervalMs = options.fixIntervalMs ?? 1000;
  const accuracyM = options.accuracyM ?? 10;
  const dwellMs = options.dwellMs ?? 4000;
  const waypoints = options.waypoints;
  if (waypoints.length === 0) return [];

  const fixes: ReplayFix[] = [];
  let t = 0;
  let prev = waypoints[0]!;

  const push = (coord: LatLng, extraMs = 0): void => {
    t += extraMs;
    let headingDeg: number | undefined;
    let speedMpsOut: number | undefined;
    if (fixes.length > 0) {
      const last = fixes[fixes.length - 1]!;
      const d = haversine(last.coord, coord);
      const dt = Math.max(fixIntervalMs, extraMs) / 1000;
      if (d > 0.5) {
        headingDeg = bearingDeg(last.coord, coord);
        speedMpsOut = d / dt;
      } else {
        speedMpsOut = 0;
      }
    }
    fixes.push({
      coord,
      offsetMs: t,
      accuracyM,
      ...(headingDeg != null ? { headingDeg } : {}),
      ...(speedMpsOut != null ? { speedMps: speedMpsOut } : {}),
    });
  };

  push(prev, 0);

  for (let i = 1; i < waypoints.length; i++) {
    const next = waypoints[i]!;
    const dist = haversine(prev, next);
    const travelMs = Math.max(fixIntervalMs, (dist / speedMps) * 1000);
    const steps = Math.max(1, Math.ceil(travelMs / fixIntervalMs));
    for (let s = 1; s <= steps; s++) {
      const frac = s / steps;
      const coord: LatLng = [
        prev[0] + (next[0] - prev[0]) * frac,
        prev[1] + (next[1] - prev[1]) * frac,
      ];
      push(coord, fixIntervalMs);
    }
    const dwellSteps = Math.max(1, Math.ceil(dwellMs / fixIntervalMs));
    for (let d = 0; d < dwellSteps; d++) {
      push(next, fixIntervalMs);
    }
    prev = next;
  }

  return fixes;
}

function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const φ1 = toRad(a[0]);
  const φ2 = toRad(b[0]);
  const Δλ = toRad(b[1] - a[1]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export const DESK_TRIP_SPEEDS = [1, 2, 4, 8] as const;
export type DeskTripSpeed = (typeof DESK_TRIP_SPEEDS)[number];
