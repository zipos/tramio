/**
 * Warsaw 180 route configuration for the simulator.
 *
 * This module imports the REAL production route data from @tramio/ui and
 * re-exports it in the shapes the simulator expects. No duplication of
 * route data — single source of truth.
 *
 * @module
 */

import {
  WARSAW_180_NORTH_GEOFENCES,
  WARSAW_180_NORTH_POIS,
  WARSAW_180_NORTH_ROUTE,
  WARSAW_180_NORTH_STOPS,
  WARSAW_180_NORTH_TOUR_CONFIG,
} from '../../ui/src/wiring/warsaw180';
import {
  MEMORIAL_POI_IDS,
  warsaw180NarrativeResolver,
  warsaw180Narratives,
} from '../../ui/src/wiring/warsaw180Narratives';
import type { PoiInfo, ReadinessConfig } from './readiness';
import type { RunnerConfig } from './runner';

export {
  WARSAW_180_NORTH_GEOFENCES,
  WARSAW_180_NORTH_POIS,
  WARSAW_180_NORTH_ROUTE,
  WARSAW_180_NORTH_STOPS,
  WARSAW_180_NORTH_TOUR_CONFIG,
  MEMORIAL_POI_IDS,
};

/** Runner config for Warsaw 180 northbound with Polish narration. */
export function warsaw180RunnerConfig(language: string = 'pl'): RunnerConfig {
  const tourConfig = { ...WARSAW_180_NORTH_TOUR_CONFIG, language };
  return {
    tourConfig,
    narrativeResolver: warsaw180NarrativeResolver,
    memorialPoiIds: MEMORIAL_POI_IDS,
  };
}

/** Readiness report config for Warsaw 180. */
export function warsaw180ReadinessConfig(): ReadinessConfig {
  const pois: PoiInfo[] = WARSAW_180_NORTH_POIS.map((p) => ({
    poiId: p.poiId,
    label: p.label,
    stopIndex: p.stopIndex,
  }));

  return {
    routeId: 'warsaw-bus-180-north',
    routeName: 'Warsaw Bus 180 Northbound (Wilanów → Żoliborz)',
    pois,
    geofences: WARSAW_180_NORTH_GEOFENCES,
    route: WARSAW_180_NORTH_ROUTE,
    languages: ['pl', 'en'],
    narrativeResolver: warsaw180NarrativeResolver,
    memorialPoiIds: MEMORIAL_POI_IDS,
  };
}

/** POI center coordinates in route order (for trace generation). */
export function warsaw180PoiCenters(): readonly [number, number][] {
  return WARSAW_180_NORTH_POIS.map((poi) => {
    const stop = WARSAW_180_NORTH_STOPS[poi.stopIndex]!;
    return [stop.coord[0], stop.coord[1]] as [number, number];
  });
}

/** All narratives map (for word-count analysis). */
export function warsaw180AllNarratives(): Readonly<Record<string, string>> {
  return warsaw180Narratives();
}
