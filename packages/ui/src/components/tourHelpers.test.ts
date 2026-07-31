// tourHelpers.test — unit tests for the next-POI selection and formatting logic.

import type { Geofence, LatLng } from '../../../engine/src';
import {
  detectMidRouteBoarding,
  findNextPoi,
  formatDistance,
  getBackgroundGuidance,
  getGpsStatus,
  getRiderPhaseLabel,
  GPS_STALE_THRESHOLD_MS,
  precomputePoiAlongRoute,
  resolveSegmentName,
} from './tourHelpers';

// ─── Test fixtures ────────────────────────────────────────────────────────────

/** A simple 3-point polyline running north. */
const ROUTE: readonly LatLng[] = [
  [52.16, 21.0],
  [52.2, 21.0],
  [52.24, 21.0],
];

function makeCircleGeofence(poiId: string, center: LatLng, radius = 100): Geofence {
  return {
    poiId,
    geometry: { kind: 'circle', center, radiusMeters: radius },
    dwellSec: 3,
    priority: 50,
    authorIndex: 0,
  };
}

const GEOFENCES: readonly Geofence[] = [
  makeCircleGeofence('poi-a', [52.17, 21.0]),
  makeCircleGeofence('poi-b', [52.19, 21.0]),
  makeCircleGeofence('poi-c', [52.22, 21.0]),
];

const POI_NAMES: ReadonlyMap<string, string> = new Map([
  ['poi-a', 'Place A'],
  ['poi-b', 'Place B'],
  ['poi-c', 'Place C'],
]);

// ─── precomputePoiAlongRoute ──────────────────────────────────────────────────

describe('precomputePoiAlongRoute', () => {
  it('projects geofences onto the route sorted by along-route distance', () => {
    const result = precomputePoiAlongRoute(GEOFENCES, ROUTE);
    expect(result).toHaveLength(3);
    expect(result[0]!.poiId).toBe('poi-a');
    expect(result[1]!.poiId).toBe('poi-b');
    expect(result[2]!.poiId).toBe('poi-c');
    // Each successive POI should be further along.
    expect(result[0]!.alongRouteM).toBeLessThan(result[1]!.alongRouteM);
    expect(result[1]!.alongRouteM).toBeLessThan(result[2]!.alongRouteM);
  });

  it('returns empty array for insufficient route points', () => {
    expect(precomputePoiAlongRoute(GEOFENCES, [[52.0, 21.0]])).toEqual([]);
  });

  it('skips polygon geofences', () => {
    const mixed: Geofence[] = [
      makeCircleGeofence('poi-a', [52.17, 21.0]),
      {
        poiId: 'poi-poly',
        geometry: {
          kind: 'polygon',
          vertices: [
            [52.18, 21.0],
            [52.18, 21.01],
            [52.19, 21.0],
          ],
        },
        dwellSec: 3,
        priority: 50,
        authorIndex: 1,
      },
    ];
    const result = precomputePoiAlongRoute(mixed, ROUTE);
    expect(result).toHaveLength(1);
    expect(result[0]!.poiId).toBe('poi-a');
  });
});

// ─── findNextPoi ──────────────────────────────────────────────────────────────

describe('findNextPoi', () => {
  const pois = precomputePoiAlongRoute(GEOFENCES, ROUTE);

  it('returns the first unconsumed POI ahead of the rider', () => {
    const consumed = new Set<string>();
    const riderPos = pois[0]!.alongRouteM + 1; // Just past POI A
    const result = findNextPoi(pois, riderPos, consumed, POI_NAMES);
    expect(result).not.toBeNull();
    expect(result!.poiId).toBe('poi-b');
    expect(result!.name).toBe('Place B');
    expect(result!.distanceM).toBeGreaterThan(0);
  });

  it('skips consumed POIs', () => {
    const consumed = new Set(['poi-b']);
    const riderPos = pois[0]!.alongRouteM + 1;
    const result = findNextPoi(pois, riderPos, consumed, POI_NAMES);
    expect(result).not.toBeNull();
    expect(result!.poiId).toBe('poi-c');
  });

  it('returns null when all POIs are consumed or behind', () => {
    const consumed = new Set<string>();
    const riderPos = pois[2]!.alongRouteM + 100; // Past the last POI
    const result = findNextPoi(pois, riderPos, consumed, POI_NAMES);
    expect(result).toBeNull();
  });

  it('uses straight-line distance when rider coord is provided and it is shorter', () => {
    const consumed = new Set<string>();
    const riderPos = 0; // At the start
    const riderCoord: LatLng = [52.169, 21.0]; // Very close to poi-a center
    const result = findNextPoi(pois, riderPos, consumed, POI_NAMES, riderCoord);
    expect(result).not.toBeNull();
    expect(result!.distanceM).toBeGreaterThan(0);
  });
});

// ─── detectMidRouteBoarding ───────────────────────────────────────────────────

describe('detectMidRouteBoarding', () => {
  const pois = precomputePoiAlongRoute(GEOFENCES, ROUTE);

  it('detects POIs behind the rider at mid-route boarding', () => {
    const consumed = new Set<string>();
    const riderPos = pois[1]!.alongRouteM + 1; // Past POI B
    const result = detectMidRouteBoarding(pois, riderPos, consumed);
    expect(result).not.toBeNull();
    expect(result!.behindCount).toBe(2); // A and B are behind
    expect(result!.aheadCount).toBe(1); // C is ahead
    expect(result!.nextPoiId).toBe('poi-c');
  });

  it('returns null when rider boards at the start', () => {
    const consumed = new Set<string>();
    const riderPos = 0;
    const result = detectMidRouteBoarding(pois, riderPos, consumed);
    expect(result).toBeNull();
  });

  it('returns null when all POIs are behind (end of route)', () => {
    const consumed = new Set<string>();
    const riderPos = pois[2]!.alongRouteM + 1000;
    const result = detectMidRouteBoarding(pois, riderPos, consumed);
    expect(result).toBeNull();
  });
});

// ─── formatDistance ───────────────────────────────────────────────────────────

describe('formatDistance', () => {
  it('formats small distances rounded to 10 m', () => {
    expect(formatDistance(47)).toBe('~50 m');
    expect(formatDistance(83)).toBe('~80 m');
  });

  it('clamps minimum to 10 m', () => {
    expect(formatDistance(3)).toBe('~10 m');
  });

  it('formats medium distances rounded to 50 m', () => {
    expect(formatDistance(127)).toBe('~150 m');
    expect(formatDistance(340)).toBe('~350 m');
    expect(formatDistance(975)).toBe('~1000 m');
  });

  it('formats large distances as km', () => {
    expect(formatDistance(1000)).toBe('~1.0 km');
    expect(formatDistance(1523)).toBe('~1.5 km');
    expect(formatDistance(2800)).toBe('~2.8 km');
  });
});

// ─── resolveSegmentName ───────────────────────────────────────────────────────

describe('resolveSegmentName', () => {
  it('extracts poiId from segment id and looks up the name', () => {
    expect(resolveSegmentName('poi-a:pl', POI_NAMES)).toBe('Place A');
    expect(resolveSegmentName('poi-b:en', POI_NAMES)).toBe('Place B');
  });

  it('falls back to raw poiId when not in map', () => {
    expect(resolveSegmentName('poi-unknown:pl', POI_NAMES)).toBe('poi-unknown');
  });

  it('handles segment ids without colon', () => {
    expect(resolveSegmentName('poi-a', POI_NAMES)).toBe('Place A');
  });
});

// ─── getGpsStatus ─────────────────────────────────────────────────────────────

describe('getGpsStatus', () => {
  it('returns acquiring when lastFixAtMs is null', () => {
    expect(getGpsStatus(null, Date.now())).toBe('acquiring');
  });

  it('returns live when fix is recent', () => {
    const now = Date.now();
    expect(getGpsStatus(now - 1000, now)).toBe('live');
  });

  it('returns acquiring when fix is stale', () => {
    const now = Date.now();
    expect(getGpsStatus(now - GPS_STALE_THRESHOLD_MS - 1, now)).toBe('acquiring');
  });
});

// ─── getRiderPhaseLabel ───────────────────────────────────────────────────────

describe('getRiderPhaseLabel', () => {
  it('maps Active to friendly language', () => {
    expect(getRiderPhaseLabel('Active')).toBe('Listening for landmarks');
  });

  it('maps Standby to rider-friendly language', () => {
    expect(getRiderPhaseLabel('Standby')).toContain('stopped');
  });

  it('maps DeadReckoning to rider-friendly language', () => {
    expect(getRiderPhaseLabel('DeadReckoning')).toContain('GPS');
  });

  it('maps Deviation to rider-friendly language', () => {
    expect(getRiderPhaseLabel('Deviation')).toContain('off the route');
  });
});

// ─── getBackgroundGuidance ────────────────────────────────────────────────────

describe('getBackgroundGuidance', () => {
  it('provides notification-specific guidance', () => {
    const msg = getBackgroundGuidance('notifications-denied');
    expect(msg).toContain('notifications');
  });

  it('provides permission-specific guidance', () => {
    const msg = getBackgroundGuidance('permission-denied');
    expect(msg).toContain('location');
  });

  it('provides generic guidance for unknown reasons', () => {
    const msg = getBackgroundGuidance('something-else');
    expect(msg).toContain('Settings');
  });
});
