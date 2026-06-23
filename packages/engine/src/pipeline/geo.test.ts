// Unit tests for geodetic helpers used by the geofence filtering pipeline.
//
// Property-based tests for the pipeline as a whole are tasks 3.3 (P1
// accuracy/spike) and 3.4 (P2 dwell+direction). These tests just pin down
// the helpers themselves on representative inputs so accidental regressions
// surface immediately rather than as drift in a downstream property.

import {
  angularDiffDeg,
  bearingDeg,
  haversine,
  pointInCircle,
  pointInPolygon,
  projectOnRoute,
} from './geo';
import type { LatLng } from '../types';

describe('haversine', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversine([51.11, 17.03], [51.11, 17.03])).toBe(0);
  });

  it('matches a known reference distance to within 0.5%', () => {
    // Wroclaw Rynek (51.110, 17.031) to Hala Stulecia (51.107, 17.077).
    // Reference distance computed independently: ~ 3208 m.
    const d = haversine([51.11, 17.031], [51.107, 17.077]);
    expect(d).toBeGreaterThan(3190);
    expect(d).toBeLessThan(3230);
  });

  it('is symmetric', () => {
    const a: LatLng = [51.11, 17.03];
    const b: LatLng = [51.13, 17.06];
    expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 9);
  });

  it('approximates 1 degree of latitude as ~111 km', () => {
    const d = haversine([0, 0], [1, 0]);
    expect(d).toBeGreaterThan(111_100);
    expect(d).toBeLessThan(111_400);
  });
});

describe('bearingDeg', () => {
  it('returns due north (0) for a northward step', () => {
    expect(bearingDeg([51.0, 17.0], [51.001, 17.0])).toBeCloseTo(0, 5);
  });

  it('returns due east (90) for an eastward step at low latitude', () => {
    expect(bearingDeg([0, 0], [0, 0.01])).toBeCloseTo(90, 3);
  });

  it('normalizes to [0, 360)', () => {
    const b = bearingDeg([51.0, 17.0], [50.999, 17.0]);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
    expect(b).toBeCloseTo(180, 5);
  });
});

describe('angularDiffDeg', () => {
  it('returns 0 for equal bearings', () => {
    expect(angularDiffDeg(45, 45)).toBe(0);
  });

  it('wraps across 0/360', () => {
    expect(angularDiffDeg(355, 5)).toBe(10);
    expect(angularDiffDeg(5, 355)).toBe(10);
  });

  it('caps at 180', () => {
    expect(angularDiffDeg(0, 180)).toBe(180);
    expect(angularDiffDeg(0, 181)).toBe(179);
  });
});

describe('projectOnRoute', () => {
  const route: readonly LatLng[] = [
    [51.0, 17.0],
    [51.0, 17.01],
    [51.01, 17.01],
  ];

  it('throws on a route with fewer than 2 vertices', () => {
    expect(() => projectOnRoute([[0, 0]], [0, 0])).toThrow();
  });

  it('returns alongRouteM ~= 0 at the route start', () => {
    const p = projectOnRoute(route, [51.0, 17.0]);
    expect(p.alongRouteM).toBeCloseTo(0, 1);
  });

  it('projects a point on the first segment partway along it', () => {
    // Point halfway along the first east-going leg.
    const p = projectOnRoute(route, [51.0, 17.005]);
    const fullSeg = haversine([51.0, 17.0], [51.0, 17.01]);
    expect(p.alongRouteM).toBeGreaterThan(fullSeg * 0.45);
    expect(p.alongRouteM).toBeLessThan(fullSeg * 0.55);
    // Tangent for the first segment is due east (~ 90).
    expect(p.tangentDeg).toBeCloseTo(90, 1);
  });

  it('clamps a point past the end onto the final vertex', () => {
    const p = projectOnRoute(route, [51.02, 17.01]);
    const seg1 = haversine([51.0, 17.0], [51.0, 17.01]);
    const seg2 = haversine([51.0, 17.01], [51.01, 17.01]);
    expect(p.alongRouteM).toBeCloseTo(seg1 + seg2, 0);
  });

  it('is monotonic along a coord that walks the polyline', () => {
    const samples: LatLng[] = [
      [51.0, 17.0],
      [51.0, 17.005],
      [51.0, 17.01],
      [51.005, 17.01],
      [51.01, 17.01],
    ];
    let prev = -Infinity;
    for (const s of samples) {
      const p = projectOnRoute(route, s);
      expect(p.alongRouteM).toBeGreaterThanOrEqual(prev);
      prev = p.alongRouteM;
    }
  });
});

describe('pointInCircle', () => {
  it('treats the center as inside', () => {
    expect(pointInCircle([51.11, 17.03], [51.11, 17.03], 60)).toBe(true);
  });

  it('treats a far-away coordinate as outside', () => {
    expect(pointInCircle([51.2, 17.2], [51.11, 17.03], 60)).toBe(false);
  });

  it('uses meters for the radius', () => {
    // ~ 11.1 m to the north
    const inside: LatLng = [51.110_1, 17.03];
    expect(pointInCircle(inside, [51.11, 17.03], 20)).toBe(true);
    expect(pointInCircle(inside, [51.11, 17.03], 5)).toBe(false);
  });
});

describe('pointInPolygon', () => {
  const square: readonly LatLng[] = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
  ];

  it('returns true for an interior point', () => {
    expect(pointInPolygon(square, [0.5, 0.5])).toBe(true);
  });

  it('returns false for an exterior point', () => {
    expect(pointInPolygon(square, [2, 2])).toBe(false);
  });

  it('returns false for a polygon with fewer than 3 vertices', () => {
    expect(
      pointInPolygon(
        [
          [0, 0],
          [1, 1],
        ],
        [0.5, 0.5],
      ),
    ).toBe(false);
  });
});
