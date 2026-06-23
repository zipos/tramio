// Priority comparator for overlapping POI triggers.
//
// When multiple POI geofences overlap and trigger simultaneously, the
// comparator selects the highest-priority POI for playback and marks
// lower-priority overlapping POIs as skipped (added to the consumed set
// so they don't replay).
//
// Tie-breaking: when two POIs share the same numeric priority, the one
// with the lower `authorIndex` (earlier in the authored pois.json array)
// wins.
//
// @see Requirement 1.6
// @see design.md "pois.json" — `priority` field

import type { Geofence, LatLng } from './types';
import { pointInCircle, pointInPolygon } from './pipeline/geo';

/**
 * Result of resolving overlapping POI triggers via priority comparison.
 */
export interface PriorityResolution {
  /** The POI that wins and should be played. */
  winnerId: string;
  /** POIs that lose and should be marked as skipped (consumed). */
  skippedIds: readonly string[];
}

/**
 * Compare two geofences by priority. Returns negative if `a` should be
 * preferred over `b`, positive if `b` should be preferred, zero if equal
 * (which should not happen given unique authorIndex values).
 *
 * Sorting order: higher priority first; on tie, lower authorIndex first.
 */
export function comparePriority(a: Geofence, b: Geofence): number {
  // Higher priority wins (sort descending by priority)
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  // Tie-breaker: lower authorIndex wins (sort ascending by authorIndex)
  return a.authorIndex - b.authorIndex;
}

/**
 * Check whether a coordinate falls within a geofence's geometry.
 */
function geofenceContains(g: Geofence, coord: LatLng): boolean {
  if (g.geometry.kind === 'circle') {
    return pointInCircle(coord, g.geometry.center, g.geometry.radiusMeters);
  }
  return pointInPolygon(g.geometry.vertices, coord);
}

/**
 * Given a triggered POI and the current smoothed position, find all other
 * geofences that overlap at that position, then resolve which POI wins
 * based on priority.
 *
 * @param triggeredPoiId - The POI that just fired via GeofenceDwell
 * @param geofences - All armed geofences for the session
 * @param smoothedCoord - The current smoothed position
 * @param consumed - POIs already consumed in this session (excluded from overlap check)
 * @returns Resolution indicating the winner and any skipped POIs, or `null`
 *          if the triggered POI is the only candidate (no overlap).
 */
export function resolveOverlappingTriggers(
  triggeredPoiId: string,
  geofences: readonly Geofence[],
  smoothedCoord: LatLng,
  consumed: ReadonlySet<string>,
): PriorityResolution {
  // Find all geofences that contain the current position and are not consumed
  const overlapping: Geofence[] = [];
  for (const g of geofences) {
    if (consumed.has(g.poiId)) continue;
    if (geofenceContains(g, smoothedCoord)) {
      overlapping.push(g);
    }
  }

  // If the triggered POI is not in the overlapping set (edge case: position
  // moved between dwell detection and reducer processing), treat it as the
  // sole candidate.
  const triggeredGeofence = overlapping.find((g) => g.poiId === triggeredPoiId);
  if (!triggeredGeofence) {
    // Fallback: just the triggered POI wins, no skips
    return { winnerId: triggeredPoiId, skippedIds: [] };
  }

  // If only one candidate, no overlap to resolve
  if (overlapping.length <= 1) {
    return { winnerId: triggeredPoiId, skippedIds: [] };
  }

  // Sort by priority (descending) then authorIndex (ascending)
  const sorted = [...overlapping].sort(comparePriority);

  const winner = sorted[0]!;
  const skipped = sorted.slice(1).map((g) => g.poiId);

  return { winnerId: winner.poiId, skippedIds: skipped };
}
