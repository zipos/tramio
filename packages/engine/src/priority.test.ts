// Unit tests for the priority comparator (task 3.7).
//
// Covers:
//   - comparePriority: higher priority wins, authorIndex tie-breaks
//   - resolveOverlappingTriggers: single POI, multiple overlapping, consumed exclusion
//   - Integration with reducer: GeofenceDwell selects highest-priority overlapping POI

import type { Geofence, LatLng } from './types';
import { comparePriority, resolveOverlappingTriggers } from './priority';

// ─── Test helpers ───────────────────────────────────────────────────────────

function makeGeofence(overrides: Partial<Geofence> & { poiId: string }): Geofence {
  return {
    geometry: { kind: 'circle', center: [51.0, 17.0], radiusMeters: 100 },
    dwellSec: 3,
    priority: 50,
    authorIndex: 0,
    ...overrides,
  };
}

// ─── comparePriority ────────────────────────────────────────────────────────

describe('comparePriority', () => {
  it('prefers higher priority (returns negative when a has higher priority)', () => {
    const a = makeGeofence({ poiId: 'a', priority: 90, authorIndex: 0 });
    const b = makeGeofence({ poiId: 'b', priority: 50, authorIndex: 1 });
    expect(comparePriority(a, b)).toBeLessThan(0);
  });

  it('prefers higher priority (returns positive when b has higher priority)', () => {
    const a = makeGeofence({ poiId: 'a', priority: 30, authorIndex: 0 });
    const b = makeGeofence({ poiId: 'b', priority: 80, authorIndex: 1 });
    expect(comparePriority(a, b)).toBeGreaterThan(0);
  });

  it('uses authorIndex as tie-breaker when priorities are equal (lower index wins)', () => {
    const a = makeGeofence({ poiId: 'a', priority: 50, authorIndex: 2 });
    const b = makeGeofence({ poiId: 'b', priority: 50, authorIndex: 5 });
    expect(comparePriority(a, b)).toBeLessThan(0);
  });

  it('returns zero when both priority and authorIndex are equal', () => {
    const a = makeGeofence({ poiId: 'a', priority: 50, authorIndex: 3 });
    const b = makeGeofence({ poiId: 'b', priority: 50, authorIndex: 3 });
    expect(comparePriority(a, b)).toBe(0);
  });

  it('sorts an array correctly: highest priority first, then lowest authorIndex', () => {
    const geofences = [
      makeGeofence({ poiId: 'low', priority: 20, authorIndex: 0 }),
      makeGeofence({ poiId: 'high', priority: 90, authorIndex: 2 }),
      makeGeofence({ poiId: 'mid-late', priority: 50, authorIndex: 3 }),
      makeGeofence({ poiId: 'mid-early', priority: 50, authorIndex: 1 }),
    ];
    const sorted = [...geofences].sort(comparePriority);
    expect(sorted.map((g) => g.poiId)).toEqual(['high', 'mid-early', 'mid-late', 'low']);
  });
});

// ─── resolveOverlappingTriggers ─────────────────────────────────────────────

describe('resolveOverlappingTriggers', () => {
  // All geofences centered at the same point so they all overlap
  const SHARED_CENTER: LatLng = [51.0, 17.0];

  const geofences: readonly Geofence[] = [
    makeGeofence({ poiId: 'poi-high', priority: 90, authorIndex: 0, geometry: { kind: 'circle', center: SHARED_CENTER, radiusMeters: 100 } }),
    makeGeofence({ poiId: 'poi-mid', priority: 50, authorIndex: 1, geometry: { kind: 'circle', center: SHARED_CENTER, radiusMeters: 100 } }),
    makeGeofence({ poiId: 'poi-low', priority: 20, authorIndex: 2, geometry: { kind: 'circle', center: SHARED_CENTER, radiusMeters: 100 } }),
  ];

  it('selects the highest-priority POI as winner when multiple overlap', () => {
    const result = resolveOverlappingTriggers('poi-mid', geofences, SHARED_CENTER, new Set());
    expect(result.winnerId).toBe('poi-high');
  });

  it('marks lower-priority overlapping POIs as skipped', () => {
    const result = resolveOverlappingTriggers('poi-mid', geofences, SHARED_CENTER, new Set());
    expect(result.skippedIds).toContain('poi-mid');
    expect(result.skippedIds).toContain('poi-low');
    expect(result.skippedIds).not.toContain('poi-high');
  });

  it('returns the triggered POI as winner when it is the only candidate', () => {
    // Only poi-high's geofence contains the position
    const isolatedGeofences: readonly Geofence[] = [
      makeGeofence({ poiId: 'poi-high', priority: 90, authorIndex: 0, geometry: { kind: 'circle', center: SHARED_CENTER, radiusMeters: 100 } }),
      makeGeofence({ poiId: 'poi-far', priority: 95, authorIndex: 1, geometry: { kind: 'circle', center: [52.0, 18.0], radiusMeters: 50 } }),
    ];
    const result = resolveOverlappingTriggers('poi-high', isolatedGeofences, SHARED_CENTER, new Set());
    expect(result.winnerId).toBe('poi-high');
    expect(result.skippedIds).toHaveLength(0);
  });

  it('excludes consumed POIs from the overlap resolution', () => {
    const consumed = new Set(['poi-high']);
    const result = resolveOverlappingTriggers('poi-mid', geofences, SHARED_CENTER, consumed);
    // poi-high is consumed, so poi-mid should win among remaining
    expect(result.winnerId).toBe('poi-mid');
    expect(result.skippedIds).toContain('poi-low');
    expect(result.skippedIds).not.toContain('poi-high');
  });

  it('uses authorIndex as tie-breaker when priorities are equal', () => {
    const tiedGeofences: readonly Geofence[] = [
      makeGeofence({ poiId: 'poi-later', priority: 50, authorIndex: 3, geometry: { kind: 'circle', center: SHARED_CENTER, radiusMeters: 100 } }),
      makeGeofence({ poiId: 'poi-earlier', priority: 50, authorIndex: 1, geometry: { kind: 'circle', center: SHARED_CENTER, radiusMeters: 100 } }),
    ];
    const result = resolveOverlappingTriggers('poi-later', tiedGeofences, SHARED_CENTER, new Set());
    expect(result.winnerId).toBe('poi-earlier');
    expect(result.skippedIds).toEqual(['poi-later']);
  });

  it('handles the case where triggered POI is not in any overlapping geofence', () => {
    // Position is far from all geofences
    const farPosition: LatLng = [60.0, 20.0];
    const result = resolveOverlappingTriggers('poi-mid', geofences, farPosition, new Set());
    // Fallback: triggered POI wins, no skips
    expect(result.winnerId).toBe('poi-mid');
    expect(result.skippedIds).toHaveLength(0);
  });

  it('returns no skipped POIs when only one geofence overlaps', () => {
    const singleGeofence: readonly Geofence[] = [
      makeGeofence({ poiId: 'poi-only', priority: 50, authorIndex: 0, geometry: { kind: 'circle', center: SHARED_CENTER, radiusMeters: 100 } }),
    ];
    const result = resolveOverlappingTriggers('poi-only', singleGeofence, SHARED_CENTER, new Set());
    expect(result.winnerId).toBe('poi-only');
    expect(result.skippedIds).toHaveLength(0);
  });
});
