// locationPowerPolicy — battery-aware location sampling for active tours.
//
// Design intent (Req 11 / design.md location mode table):
//   - Cruise between POIs with throttled High accuracy (still clears the
//     50 m pipeline gate outdoors; Balanced's ~100 m class would thrash).
//   - Tighten time/distance intervals only in approach / reconcile windows.
//   - Never use BestForNavigation (extra sensors) on the Expo path.
//
// Adaptive approach is computed in LocationAdapter from distance-to-fence
// because the pure engine currently emits `tour-bg` / `reconcile` / `idle`
// and does not yet emit `tour-approach` on its own.

import type { Geofence, LatLng, LocationMode } from '../../../engine/src';
import { haversine, pointInPolygon } from '../../../engine/src';

/** Effective sampling band applied to expo-location watches / tasks. */
export type LocationPowerBand = 'cruise' | 'approach';

/**
 * Metres outside a geofence edge that enter the approach band.
 * At ~8 m/s bus speed this is ~20–25 s of look-ahead before the fence.
 */
export const APPROACH_ENTER_M = 150;

/**
 * Metres outside a geofence edge that leave the approach band.
 * Hysteresis above APPROACH_ENTER_M avoids thrashing restarts.
 */
export const APPROACH_EXIT_M = 250;

/** Minimum ms between provider restarts when only the band changes. */
export const MODE_RESTART_COOLDOWN_MS = 8_000;

export interface LocationSamplingOptions {
  readonly accuracy: number;
  readonly timeInterval: number;
  readonly distanceInterval: number;
  readonly pausesUpdatesAutomatically: boolean;
  /** expo-location ActivityType numeric; OtherNavigation = 5. */
  readonly activityType: number;
}

/**
 * Numeric Accuracy / ActivityType mirrors of expo-location enums so this
 * module stays testable without importing the native module.
 * Keep in sync with LocationAccuracy / LocationActivityType.
 */
export const ExpoAccuracy = {
  Balanced: 3,
  High: 4,
  Highest: 5,
  BestForNavigation: 6,
} as const;

export const ExpoActivityType = {
  Other: 1,
  AutomotiveNavigation: 2,
  OtherNavigation: 5,
} as const;

/**
 * Cruise: High accuracy class (~10 m) but sparse updates so the GNSS radio
 * can sleep between fixes. pausesUpdatesAutomatically stays false — iOS OS
 * pause/resume is opaque and can lag through traffic stops, which risks
 * late approach sampling near POIs. Battery win comes from the interval.
 */
export const CRUISE_SAMPLING: LocationSamplingOptions = Object.freeze({
  accuracy: ExpoAccuracy.High,
  timeInterval: 4_000,
  distanceInterval: 25,
  pausesUpdatesAutomatically: false,
  activityType: ExpoActivityType.OtherNavigation,
});

/**
 * Approach / reconcile: still High (not BestForNavigation), denser so the
 * 3 s dwell accumulator gets enough samples inside the fence.
 */
export const APPROACH_SAMPLING: LocationSamplingOptions = Object.freeze({
  accuracy: ExpoAccuracy.High,
  timeInterval: 1_000,
  distanceInterval: 5,
  pausesUpdatesAutomatically: false,
  activityType: ExpoActivityType.OtherNavigation,
});

/** Engine mode → default band before adaptive distance override. */
export function bandForEngineMode(mode: LocationMode): LocationPowerBand {
  if (mode === 'tour-approach' || mode === 'reconcile') return 'approach';
  return 'cruise';
}

export function samplingForBand(band: LocationPowerBand): LocationSamplingOptions {
  return band === 'approach' ? APPROACH_SAMPLING : CRUISE_SAMPLING;
}

/**
 * Distance in metres from `coord` to the outside of a geofence (0 if inside).
 */
export function distanceOutsideGeofence(coord: LatLng, fence: Geofence): number {
  if (fence.geometry.kind === 'circle') {
    const d = haversine(coord, fence.geometry.center);
    return Math.max(0, d - fence.geometry.radiusMeters);
  }
  if (pointInPolygon(fence.geometry.vertices, coord)) return 0;
  let min = Number.POSITIVE_INFINITY;
  for (const v of fence.geometry.vertices) {
    const d = haversine(coord, v);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Minimum distance outside any unconsumed geofence. `Infinity` if none left.
 */
export function minDistanceOutsideUnconsumed(
  coord: LatLng,
  geofences: readonly Geofence[],
  consumed: ReadonlySet<string>,
): number {
  let min = Number.POSITIVE_INFINITY;
  for (const fence of geofences) {
    if (consumed.has(fence.poiId)) continue;
    const d = distanceOutsideGeofence(coord, fence);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Hysteresis: stay in approach until clearly clear of all remaining fences.
 */
export function resolveAdaptiveBand(
  coord: LatLng,
  geofences: readonly Geofence[],
  consumed: ReadonlySet<string>,
  currentlyApproach: boolean,
): LocationPowerBand {
  const d = minDistanceOutsideUnconsumed(coord, geofences, consumed);
  if (!Number.isFinite(d)) return 'cruise';
  if (currentlyApproach) {
    return d <= APPROACH_EXIT_M ? 'approach' : 'cruise';
  }
  return d <= APPROACH_ENTER_M ? 'approach' : 'cruise';
}

/**
 * Combine engine-forced mode with adaptive proximity.
 * `reconcile` / explicit `tour-approach` always win.
 */
export function resolveEffectiveBand(
  engineMode: LocationMode,
  adaptive: LocationPowerBand,
): LocationPowerBand {
  const forced = bandForEngineMode(engineMode);
  if (forced === 'approach') return 'approach';
  return adaptive;
}

export function samplingOptionsEqual(
  a: LocationSamplingOptions,
  b: LocationSamplingOptions,
): boolean {
  return (
    a.accuracy === b.accuracy &&
    a.timeInterval === b.timeInterval &&
    a.distanceInterval === b.distanceInterval &&
    a.pausesUpdatesAutomatically === b.pausesUpdatesAutomatically &&
    a.activityType === b.activityType
  );
}
