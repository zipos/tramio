// demoRoute — embedded Warsaw demo content (fallback when catalog is unreachable).
//
// The flagship route is bus 180 northbound, Wilanów → Żoliborz, defined in
// `warsaw180.ts` with stop coordinates sourced from OpenStreetMap.
//
// The previous demo route (`warsaw-tram-22-east`) has been retired: it
// described the summer-shortened tram 22, which reverted to its normal
// alignment in early August 2026, so its narration and its terminus POI
// were both about to become false. Bus 180 is a permanent, year-round
// line, which makes it a safe subject for authored content.
//
// Installed packs from Storage_Manager take precedence on the route
// selection screen; this embedded copy is the offline fallback.

import type { StartTourConfig } from '../../../engine/src';
import {
  WARSAW_180_NORTH_BUNDLE_ID,
  WARSAW_180_NORTH_POIS,
  WARSAW_180_NORTH_TOUR_CONFIG,
} from './warsaw180';

export interface DemoPoi {
  poiId: string;
  label: string;
}

export interface DemoRoute {
  routeId: string;
  title: string;
  description: string;
  language: string;
  pois: readonly DemoPoi[];
  tourConfig: StartTourConfig;
}

export const WARSAW_BUS_180_NORTH: DemoRoute = {
  routeId: WARSAW_180_NORTH_BUNDLE_ID,
  title: 'Warsaw Bus 180 — northbound',
  description:
    'Wilanów → Żoliborz along the Trakt Królewski. A scheduled city bus that happens to run the whole Royal Route, then continues through Muranów and Powązki.',
  language: 'pl',
  pois: WARSAW_180_NORTH_POIS.map((poi) => ({ poiId: poi.poiId, label: poi.label })),
  tourConfig: WARSAW_180_NORTH_TOUR_CONFIG,
};

/** Demo routes shown on the route selection screen. */
export const DEMO_ROUTES: readonly DemoRoute[] = [WARSAW_BUS_180_NORTH];

export function findDemoRoute(bundleId: string): DemoRoute | undefined {
  return DEMO_ROUTES.find((r) => r.routeId === bundleId);
}
