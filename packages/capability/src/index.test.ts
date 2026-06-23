/**
 * Smoke unit tests for @tramio/capability task 9.1.
 *
 * Required assertions per the task brief:
 *   (a) every documented flag has a non-empty fallback string,
 *   (b) `defaultCapabilities()` is conservative (no flag accidentally true),
 *   (c) `probeCapabilities()` correctly upgrades a flag when the native side
 *       returns true.
 */

import {
  ALL_CAPABILITY_FLAGS,
  defaultCapabilities,
  OS_MATRIX,
  osMatrixDefaults,
  osMatrixSupports,
  probeCapabilities,
} from './index';

describe('OS_MATRIX descriptor table', () => {
  it('declares a descriptor for every capability flag', () => {
    // Sanity: ALL_CAPABILITY_FLAGS and OS_MATRIX agree on the flag set.
    expect(Object.keys(OS_MATRIX).sort()).toEqual([...ALL_CAPABILITY_FLAGS].sort());
  });

  it('every documented flag has a non-empty fallback string (Req 15.4)', () => {
    // Required assertion (a). Surfaced via FlagDescriptor.documentedFallback
    // so downstream code (and tests in task 9.3) can introspect it.
    for (const flag of ALL_CAPABILITY_FLAGS) {
      const descriptor = OS_MATRIX[flag];
      expect(descriptor.flag).toBe(flag);
      expect(typeof descriptor.documentedFallback).toBe('string');
      expect(descriptor.documentedFallback.trim().length).toBeGreaterThan(0);
      // A non-empty rationale and modernApi citation is not strictly required
      // by the task but they are part of the descriptor contract.
      expect(descriptor.modernApi.length).toBeGreaterThan(0);
      expect(descriptor.rationale.length).toBeGreaterThan(0);
    }
  });

  it('declares iOS and Android baselines for every flag', () => {
    for (const flag of ALL_CAPABILITY_FLAGS) {
      const { platforms } = OS_MATRIX[flag];
      const ios = platforms.ios.minOsVersion;
      const android = platforms.android.minOsVersion;
      // null is allowed (capability not offered on that platform); positive
      // integers are valid OS versions / API levels.
      expect(ios === null || (typeof ios === 'number' && ios > 0)).toBe(true);
      expect(android === null || (typeof android === 'number' && android > 0)).toBe(true);
    }
  });
});

describe('defaultCapabilities()', () => {
  it('is conservative — no flag accidentally true', () => {
    // Required assertion (b).
    const caps = defaultCapabilities();
    for (const flag of ALL_CAPABILITY_FLAGS) {
      expect(caps[flag]).toBe(false);
    }
  });

  it('returns a frozen snapshot so consumers cannot mutate it', () => {
    const caps = defaultCapabilities();
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it('exposes the same flag set as the OS_MATRIX descriptor table', () => {
    expect(Object.keys(defaultCapabilities()).sort()).toEqual(
      Object.keys(OS_MATRIX).sort(),
    );
  });
});

describe('probeCapabilities()', () => {
  it('returns the conservative baseline for an unknown platform', () => {
    const caps = probeCapabilities('unknown', 999);
    for (const flag of ALL_CAPABILITY_FLAGS) {
      expect(caps[flag]).toBe(false);
    }
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it('uses the OS_MATRIX defaults when no native probe is supplied', () => {
    // iOS 17 should light up regionMonitoringV2 per the matrix floor (iOS 17),
    // and isolatedAudioFocus (iOS 14 floor).
    const caps = probeCapabilities('ios', 17);
    expect(caps.regionMonitoringV2).toBe(osMatrixSupports('regionMonitoringV2', 'ios', 17));
    expect(caps.isolatedAudioFocus).toBe(true);
    // Android-only flags must remain false on iOS regardless of version.
    expect(caps.foregroundServicePartialWakelock).toBe(false);
    expect(caps.strongBoxAvailable).toBe(false);
  });

  it('upgrades a flag to true when the native probe answers true', () => {
    // Required assertion (c). On iOS 12, the matrix floor for
    // regionMonitoringV2 (iOS 17) is not met, so the matrix default is false.
    const matrixOnly = osMatrixDefaults('ios', 12);
    expect(matrixOnly.regionMonitoringV2).toBe(false);

    const upgraded = probeCapabilities('ios', 12, { regionMonitoringV2: true });
    expect(upgraded.regionMonitoringV2).toBe(true);
    // Other flags are unaffected by the override.
    expect(upgraded.liveActivities).toBe(matrixOnly.liveActivities);
    expect(upgraded.isolatedAudioFocus).toBe(matrixOnly.isolatedAudioFocus);
    expect(Object.isFrozen(upgraded)).toBe(true);
  });

  it('lets the native probe explicitly downgrade a flag', () => {
    // Even at API 31, a custom Android image may report no StrongBox.
    const matrixOnly = osMatrixDefaults('android', 31);
    expect(matrixOnly.strongBoxAvailable).toBe(true);

    const downgraded = probeCapabilities('android', 31, { strongBoxAvailable: false });
    expect(downgraded.strongBoxAvailable).toBe(false);
  });

  it('treats an undefined native field as "no answer" and falls back to the matrix', () => {
    const matrixOnly = osMatrixDefaults('android', 34);
    const merged = probeCapabilities('android', 34, {
      // Only an explicit override; everything else is `undefined`.
      aesNiAccel: false,
    });
    expect(merged.aesNiAccel).toBe(false);
    expect(merged.foregroundServicePartialWakelock).toBe(
      matrixOnly.foregroundServicePartialWakelock,
    );
    expect(merged.isolatedAudioFocus).toBe(matrixOnly.isolatedAudioFocus);
  });

  it('coerces non-finite OS versions to the conservative baseline', () => {
    const caps = probeCapabilities('ios', Number.NaN);
    for (const flag of ALL_CAPABILITY_FLAGS) {
      expect(caps[flag]).toBe(false);
    }
  });
});
