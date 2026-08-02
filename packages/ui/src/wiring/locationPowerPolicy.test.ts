// locationPowerPolicy.test.ts — pure policy unit tests (no native modules).

import type { Geofence, LatLng } from '../../../engine/src';
import {
  APPROACH_ENTER_M,
  APPROACH_EXIT_M,
  APPROACH_SAMPLING,
  CRUISE_SAMPLING,
  bandForEngineMode,
  distanceOutsideGeofence,
  minDistanceOutsideUnconsumed,
  resolveAdaptiveBand,
  resolveEffectiveBand,
  samplingForBand,
  samplingOptionsEqual,
} from './locationPowerPolicy';

function circle(poiId: string, center: LatLng, radiusMeters: number): Geofence {
  return {
    poiId,
    geometry: { kind: 'circle', center, radiusMeters },
    dwellSec: 3,
    priority: 50,
    authorIndex: 0,
  };
}

describe('locationPowerPolicy', () => {
  const origin: LatLng = [52.2, 21.0];
  const fence = circle('poi-a', origin, 100);

  it('maps engine modes to bands', () => {
    expect(bandForEngineMode('tour-bg')).toBe('cruise');
    expect(bandForEngineMode('standby')).toBe('cruise');
    expect(bandForEngineMode('idle')).toBe('cruise');
    expect(bandForEngineMode('tour-approach')).toBe('approach');
    expect(bandForEngineMode('reconcile')).toBe('approach');
  });

  it('cruise sampling is sparser than approach', () => {
    expect(CRUISE_SAMPLING.timeInterval).toBeGreaterThan(APPROACH_SAMPLING.timeInterval);
    expect(CRUISE_SAMPLING.distanceInterval).toBeGreaterThan(APPROACH_SAMPLING.distanceInterval);
    expect(CRUISE_SAMPLING.pausesUpdatesAutomatically).toBe(false);
    expect(APPROACH_SAMPLING.pausesUpdatesAutomatically).toBe(false);
    expect(samplingForBand('cruise')).toBe(CRUISE_SAMPLING);
    expect(samplingForBand('approach')).toBe(APPROACH_SAMPLING);
  });

  it('distanceOutsideGeofence is 0 inside and radius-aware outside', () => {
    expect(distanceOutsideGeofence(origin, fence)).toBe(0);
    // ~200 m north of center → ~100 m outside a 100 m radius
    const north: LatLng = [52.2018, 21.0];
    const d = distanceOutsideGeofence(north, fence);
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(150);
  });

  it('ignores consumed fences when computing min distance', () => {
    const far = circle('poi-far', [52.3, 21.0], 50);
    const dAll = minDistanceOutsideUnconsumed(origin, [fence, far], new Set());
    expect(dAll).toBe(0);
    const dSkip = minDistanceOutsideUnconsumed(origin, [fence, far], new Set(['poi-a']));
    expect(dSkip).toBeGreaterThan(1000);
  });

  it('enters approach within APPROACH_ENTER_M of the fence edge', () => {
    // Sit just inside enter threshold outside the edge.
    const near: LatLng = [52.2 + (100 + APPROACH_ENTER_M - 20) / 111_320, 21.0];
    expect(resolveAdaptiveBand(near, [fence], new Set(), false)).toBe('approach');
  });

  it('uses hysteresis before leaving approach', () => {
    const between: LatLng = [52.2 + (100 + APPROACH_ENTER_M + 20) / 111_320, 21.0];
    // Outside enter, inside exit → stay in approach if already there.
    expect(resolveAdaptiveBand(between, [fence], new Set(), true)).toBe('approach');
    expect(resolveAdaptiveBand(between, [fence], new Set(), false)).toBe('cruise');

    const far: LatLng = [52.2 + (100 + APPROACH_EXIT_M + 50) / 111_320, 21.0];
    expect(resolveAdaptiveBand(far, [fence], new Set(), true)).toBe('cruise');
  });

  it('engine approach/reconcile overrides adaptive cruise', () => {
    expect(resolveEffectiveBand('reconcile', 'cruise')).toBe('approach');
    expect(resolveEffectiveBand('tour-approach', 'cruise')).toBe('approach');
    expect(resolveEffectiveBand('tour-bg', 'approach')).toBe('approach');
    expect(resolveEffectiveBand('tour-bg', 'cruise')).toBe('cruise');
  });

  it('samplingOptionsEqual compares fields', () => {
    expect(samplingOptionsEqual(CRUISE_SAMPLING, CRUISE_SAMPLING)).toBe(true);
    expect(samplingOptionsEqual(CRUISE_SAMPLING, APPROACH_SAMPLING)).toBe(false);
  });
});
