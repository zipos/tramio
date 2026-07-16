// demoRoute — embedded Warsaw demo content (fallback when catalog is unreachable).
//
// Geometry mirrors the summer-shortened line 22 pack (Praga → Plac Starynkiewicza).
// Installed packs from Storage_Manager take precedence on the route selection screen.

import type { StartTourConfig } from '../../../engine/src';

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

export const WARSAW_TRAM_22_EAST: DemoRoute = {
  routeId: 'warsaw-tram-22-east',
  title: 'Warsaw Tram 22 — East (summer)',
  description:
    'Praga → Plac Starynkiewicza. Shortened summer route until track works finish (~2 Aug).',
  language: 'pl',
  pois: [
    { poiId: 'poi-stadion-narodowy', label: 'PGE Narodowy' },
    { poiId: 'poi-powisle', label: 'Powiśle / Wisła' },
    { poiId: 'poi-starynkiewicza', label: 'Plac Starynkiewicza (terminus)' },
  ],
  tourConfig: {
    bundle: { bundleId: 'warsaw-tram-22-east', bundleVersion: '1.0.0' },
    geofences: [
      {
        poiId: 'poi-stadion-narodowy',
        geometry: { kind: 'circle', center: [52.2394, 21.0455], radiusMeters: 150 },
        dwellSec: 3,
        priority: 80,
        authorIndex: 0,
      },
      {
        poiId: 'poi-powisle',
        geometry: { kind: 'circle', center: [52.237, 21.026], radiusMeters: 100 },
        dwellSec: 3,
        priority: 70,
        authorIndex: 1,
      },
      {
        poiId: 'poi-starynkiewicza',
        geometry: { kind: 'circle', center: [52.2292, 21.0125], radiusMeters: 80 },
        dwellSec: 3,
        priority: 90,
        authorIndex: 2,
      },
    ],
    route: [
      [52.244, 21.038],
      [52.241, 21.032],
      [52.237, 21.026],
      [52.233, 21.02],
      [52.2292, 21.0125],
    ],
    language: 'pl',
  },
};

/** Demo routes shown on the route selection screen. */
export const DEMO_ROUTES: readonly DemoRoute[] = [WARSAW_TRAM_22_EAST];

export function findDemoRoute(bundleId: string): DemoRoute | undefined {
  return DEMO_ROUTES.find((r) => r.routeId === bundleId);
}
