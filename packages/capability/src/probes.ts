/**
 * Runtime capability probes (task 9.1).
 *
 * `probeCapabilities(platform, osVersion, native?)` is pure: it combines the
 * static `OS_MATRIX` defaults for `(platform, osVersion)` with optional
 * native-side probe results (the shape tasks 8.x will satisfy from their
 * turbo modules) and produces a frozen `Capabilities` record.
 *
 * Resolution rule: a native answer (true OR false) always wins over the
 * matrix default, in either direction. This lets a custom Android image at
 * API 31 still report `strongBoxAvailable: false`, and lets a future iOS
 * point release flip a flag on without bumping the matrix floor.
 *
 * The function is intentionally side-effect-free and dependency-free so it
 * can be exercised under property tests without any native bridge.
 */
import { osMatrixDefaults } from './os-matrix';
import type {
  Capabilities,
  CapabilityFlag,
  CapabilityPlatform,
  NativeCapabilityProbe,
} from './types';

/**
 * Conservative-baseline `Capabilities` record. Every flag is `false` (the
 * safest fallback). Useful for unit tests, for early-boot consumers that
 * have not yet run a real probe, and for satisfying Req 15.4 when the
 * platform is unknown.
 */
export function defaultCapabilities(): Capabilities {
  return Object.freeze({
    regionMonitoringV2: false,
    liveActivities: false,
    foregroundServicePartialWakelock: false,
    isolatedAudioFocus: false,
    dynamicTypeXL: false,
    secureEnclaveAvailable: false,
    strongBoxAvailable: false,
    aesNiAccel: false,
  });
}

const ALL_FLAGS: ReadonlyArray<CapabilityFlag> = [
  'regionMonitoringV2',
  'liveActivities',
  'foregroundServicePartialWakelock',
  'isolatedAudioFocus',
  'dynamicTypeXL',
  'secureEnclaveAvailable',
  'strongBoxAvailable',
  'aesNiAccel',
];

/**
 * Combine the OS-matrix default for `(platform, osVersion)` with optional
 * native probe answers. Returns a frozen `Capabilities` record that is safe
 * to share across the app for the lifetime of a session.
 *
 * @param platform   `'ios'`, `'android'`, or `'unknown'`. `'unknown'` always
 *                   yields the conservative baseline (Req 15.4).
 * @param osVersion  Major iOS version or Android API level. Non-finite or
 *                   negative values are treated as `0`, which yields the
 *                   conservative baseline.
 * @param native     Optional native-side probe results from tasks 8.x. Any
 *                   field set to a boolean overrides the matrix default;
 *                   `undefined` fields fall through to the matrix.
 */
export function probeCapabilities(
  platform: CapabilityPlatform,
  osVersion: number,
  native?: NativeCapabilityProbe,
): Capabilities {
  const safeVersion = Number.isFinite(osVersion) && osVersion > 0 ? Math.floor(osVersion) : 0;
  const matrixDefaults = osMatrixDefaults(platform, safeVersion);

  if (!native) {
    return matrixDefaults;
  }

  const merged: Record<CapabilityFlag, boolean> = {
    regionMonitoringV2: matrixDefaults.regionMonitoringV2,
    liveActivities: matrixDefaults.liveActivities,
    foregroundServicePartialWakelock: matrixDefaults.foregroundServicePartialWakelock,
    isolatedAudioFocus: matrixDefaults.isolatedAudioFocus,
    dynamicTypeXL: matrixDefaults.dynamicTypeXL,
    secureEnclaveAvailable: matrixDefaults.secureEnclaveAvailable,
    strongBoxAvailable: matrixDefaults.strongBoxAvailable,
    aesNiAccel: matrixDefaults.aesNiAccel,
  };

  for (const flag of ALL_FLAGS) {
    const override = native[flag];
    if (typeof override === 'boolean') {
      merged[flag] = override;
    }
  }

  return Object.freeze(merged);
}
