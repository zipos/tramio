// warsawDeskTrace — compact GPS waypoints for Poco desk replay (__DEV__).

import type { LatLng } from '../../../engine/src';
import { WARSAW_180_NORTH_GEOFENCES } from './warsaw180';
import { buildDeskTrace, type ReplayFix } from './gpsReplay';

/** Default: full Warsaw Bus 180 route through all 24 POIs for desk rides. */
export const DESK_REPLAY_POI_COUNT = 24;

export function warsaw180DeskWaypoints(count: number = DESK_REPLAY_POI_COUNT): LatLng[] {
  const out: LatLng[] = [];
  for (const fence of WARSAW_180_NORTH_GEOFENCES) {
    if (out.length >= count) break;
    if (fence.geometry.kind !== 'circle') continue;
    out.push(fence.geometry.center);
  }
  return out;
}

export function buildWarsaw180DeskTrace(options?: {
  poiCount?: number;
  speedMultiplierHint?: number;
}): ReplayFix[] {
  const waypoints = warsaw180DeskWaypoints(options?.poiCount ?? DESK_REPLAY_POI_COUNT);
  return buildDeskTrace({
    waypoints,
    speedMps: 8,
    fixIntervalMs: 1000,
    accuracyM: 10,
    dwellMs: 4000,
  });
}
