// tourHelpers — Pure logic for next-POI selection and distance formatting.
//
// These helpers are driven by the engine's along-route projection. We
// precompute each geofence's along-route distance once per tour start,
// then on each GPS tick find the nearest unconsumed POI AHEAD of the
// rider's current position.
//
// @see FIX 1, FIX 7 in the UX fixes spec.

import type { Geofence, LatLng } from '../../../engine/src';
import { haversine, projectOnRoute } from '../../../engine/src';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PoiAlongRoute {
  poiId: string;
  /** Distance along the route polyline to this POI's geofence centre, in metres. */
  alongRouteM: number;
  /** Geofence centre for straight-line fallback. */
  center: LatLng;
}

export interface NextPoiInfo {
  poiId: string;
  /** Human-readable name. */
  name: string;
  /** Distance to the next POI in metres (along-route or straight-line). */
  distanceM: number;
}

export interface MidRouteBoardingInfo {
  /** How many POIs are behind the rider. */
  behindCount: number;
  /** How many POIs are ahead. */
  aheadCount: number;
  /** The POI id of the next one ahead. */
  nextPoiId: string;
}

// ─── Precomputation (memoized once per tour) ──────────────────────────────────

/**
 * Project every geofence's centre onto the route polyline.
 * Call once at tour start and memoize the result.
 */
export function precomputePoiAlongRoute(
  geofences: readonly Geofence[],
  route: readonly LatLng[],
): readonly PoiAlongRoute[] {
  if (route.length < 2) return [];

  const result: PoiAlongRoute[] = [];
  for (const gf of geofences) {
    if (gf.geometry.kind !== 'circle') continue;
    const center = gf.geometry.center;
    const projection = projectOnRoute(route, center);
    result.push({
      poiId: gf.poiId,
      alongRouteM: projection.alongRouteM,
      center,
    });
  }

  // Sort by along-route distance so sequential scans work correctly.
  result.sort((a, b) => a.alongRouteM - b.alongRouteM);
  return result;
}

// ─── Per-fix computation ──────────────────────────────────────────────────────

/**
 * Find the nearest unconsumed POI AHEAD of the rider's current position.
 * Returns null if all POIs are behind or consumed.
 */
export function findNextPoi(
  poisAlongRoute: readonly PoiAlongRoute[],
  riderAlongRouteM: number,
  consumed: ReadonlySet<string>,
  poiNames: ReadonlyMap<string, string>,
  riderCoord?: LatLng,
): NextPoiInfo | null {
  let bestAhead: PoiAlongRoute | null = null;

  for (const poi of poisAlongRoute) {
    if (consumed.has(poi.poiId)) continue;
    // POI is ahead if its along-route position is greater than the rider's.
    if (poi.alongRouteM > riderAlongRouteM) {
      bestAhead = poi;
      break; // Already sorted: first match is the closest ahead.
    }
  }

  if (bestAhead === null) return null;

  // Distance: prefer along-route (straightforward subtraction).
  let distanceM = bestAhead.alongRouteM - riderAlongRouteM;

  // If rider coord is available, take the minimum of along-route and straight-line.
  if (riderCoord) {
    const straightLine = haversine(riderCoord, bestAhead.center);
    distanceM = Math.min(distanceM, straightLine);
  }

  const name = poiNames.get(bestAhead.poiId) ?? bestAhead.poiId;
  return { poiId: bestAhead.poiId, name, distanceM };
}

/**
 * Detect mid-route boarding: on the first fix, identify how many POIs
 * are already behind the rider.
 */
export function detectMidRouteBoarding(
  poisAlongRoute: readonly PoiAlongRoute[],
  riderAlongRouteM: number,
  consumed: ReadonlySet<string>,
): MidRouteBoardingInfo | null {
  let behindCount = 0;
  let firstAheadId: string | null = null;

  for (const poi of poisAlongRoute) {
    if (consumed.has(poi.poiId)) continue;
    if (poi.alongRouteM <= riderAlongRouteM) {
      behindCount++;
    } else {
      if (firstAheadId === null) {
        firstAheadId = poi.poiId;
      }
    }
  }

  // Only show if there are skipped POIs AND there are POIs ahead.
  if (behindCount === 0 || firstAheadId === null) return null;

  const aheadCount = poisAlongRoute.filter(
    (p) => !consumed.has(p.poiId) && p.alongRouteM > riderAlongRouteM,
  ).length;

  return { behindCount, aheadCount, nextPoiId: firstAheadId };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Format a distance in metres for rider display.
 * - Under 100 m: show to nearest 10 m (e.g. '~80 m')
 * - 100–999 m: show rounded to nearest 50 m (e.g. '~350 m')
 * - 1000+ m: show as km with one decimal (e.g. '~1.2 km')
 */
export function formatDistance(metres: number): string {
  if (metres < 100) {
    const rounded = Math.round(metres / 10) * 10;
    return `~${Math.max(rounded, 10)} m`;
  }
  if (metres < 1000) {
    const rounded = Math.round(metres / 50) * 50;
    return `~${rounded} m`;
  }
  const km = metres / 1000;
  return `~${km.toFixed(1)} km`;
}

/**
 * Resolve a segment id (e.g. 'poi-lazienki:pl') to a human-readable POI name.
 */
export function resolveSegmentName(
  segmentId: string,
  poiNames: ReadonlyMap<string, string>,
): string {
  // Segment ids have format '{poiId}:{lang}'
  const colonIdx = segmentId.lastIndexOf(':');
  const poiId = colonIdx === -1 ? segmentId : segmentId.slice(0, colonIdx);
  return poiNames.get(poiId) ?? poiId;
}

// ─── GPS liveness ─────────────────────────────────────────────────────────────

/** How many ms without a fix before we show "Acquiring GPS…" */
export const GPS_STALE_THRESHOLD_MS = 8_000;

export type GpsStatus = 'live' | 'acquiring';

/**
 * Determine GPS liveness from the last fix timestamp.
 */
export function getGpsStatus(lastFixAtMs: number | null, nowMs: number): GpsStatus {
  if (lastFixAtMs === null) return 'acquiring';
  if (nowMs - lastFixAtMs > GPS_STALE_THRESHOLD_MS) return 'acquiring';
  return 'live';
}

// ─── Phase labels (rider-facing) ──────────────────────────────────────────────

/**
 * Convert engine phase names to plain rider language.
 */
export function getRiderPhaseLabel(phase: string): string {
  switch (phase) {
    case 'Active':
      return 'Listening for landmarks';
    case 'Standby':
      return 'Bus is stopped — narration resumes when you move';
    case 'DeadReckoning':
      return 'GPS signal weak — narration continues on schedule';
    case 'Deviation':
      return 'You appear to be off the route';
    default:
      return phase;
  }
}

// ─── Background status guidance ───────────────────────────────────────────────

/**
 * Map the background status reason to rider-facing guidance.
 */
export function getBackgroundGuidance(reason?: string): string {
  switch (reason) {
    case 'notifications-denied':
      return 'Narration will pause when the screen locks. Enable notifications in Settings to allow background playback.';
    case 'permission-denied':
      return 'Narration will pause when the screen locks. Allow "Always" location access in Settings for uninterrupted playback.';
    default:
      return 'Narration may pause when the screen locks. Check location permissions in Settings.';
  }
}
