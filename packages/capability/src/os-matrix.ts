/**
 * OS_MATRIX descriptor table (task 9.1).
 *
 * Static table mapping each capability flag to:
 *   - the iOS / Android OS versions on which the modern native API is
 *     supported (the baseline default for the flag is `true` from that
 *     version onward),
 *   - the documented fallback path used when the flag is false (Req 15.4),
 *   - a short rationale citing the requirement clause and / or design.md
 *     section the flag satisfies.
 *
 * Reference APIs (per design.md "Capability_Layer" + "Capability Layer
 * Strategy"):
 *   - regionMonitoringV2:               CoreLocation region monitoring v2
 *                                       (`CLMonitor`, iOS 17+) /
 *                                       `GeofencingClient` v2 (Android 12+).
 *   - liveActivities:                   ActivityKit Live Activities (iOS 16.1+).
 *   - foregroundServicePartialWakelock: `FOREGROUND_SERVICE_PARTIAL_WAKELOCK`
 *                                       FGS type contract (Android 14+).
 *   - isolatedAudioFocus:               `AVAudioSession` isolated focus /
 *                                       `AudioFocusRequest` with isolated-grant
 *                                       semantics.
 *   - dynamicTypeXL:                    Dynamic Type XL+ accessibility scales.
 *   - secureEnclaveAvailable:           Secure Enclave-backed Keychain item
 *                                       class (`kSecAttrTokenIDSecureEnclave`).
 *   - strongBoxAvailable:               `PackageManager.FEATURE_STRONGBOX_KEYSTORE`.
 *   - aesNiAccel:                       CPU AES hardware acceleration
 *                                       (informational only).
 *
 * The matrix is the single source of truth consumed by `probeCapabilities()`
 * in `probes.ts`. Command translators (task 9.2) read the booleans produced
 * by the probe, never the matrix directly, so newer paths can be enabled
 * without reshaping the engine (Req 15.4).
 */
import type {
  Capabilities,
  CapabilityFlag,
  CapabilityPlatform,
  FlagDescriptor,
  PerPlatformBaseline,
} from './types';

/**
 * The OS_MATRIX. Order is irrelevant — consumers look up by flag.
 *
 * Version floors are conservative: a modern API is only claimed when the
 * stable OS release shipped it AND we ship the matching native code path
 * (tasks 8.1–8.6). When in doubt the fallback path wins, since Req 15.4
 * forbids any active-tour regression on the legacy path.
 */
export const OS_MATRIX: Readonly<Record<CapabilityFlag, FlagDescriptor>> = Object.freeze({
  regionMonitoringV2: {
    flag: 'regionMonitoringV2',
    modernApi:
      'CoreLocation region monitoring v2 (`CLMonitor`, iOS 17+) / `GeofencingClient` v2 (Android 12+)',
    // iOS 17 ships `CLMonitor`; Android 12 (API 31) tightened the geofencing
    // API contract we target as "v2".
    platforms: {
      ios: { minOsVersion: 17 },
      android: { minOsVersion: 31 },
    },
    documentedFallback:
      'Use Location_Service.armGeofencesLegacy(...) — the pre-v2 region-monitoring path ' +
      'with the standard 20-region cap and the existing accuracy / spike gates. ' +
      'Engine invariants P1, P2 hold unchanged on this path.',
    rationale:
      'Req 15.2/15.3/15.4 + design.md "Capability Layer Strategy". The engine selects v2 ' +
      'vs legacy via this flag; both paths share the same EngineCommand surface.',
  },
  liveActivities: {
    flag: 'liveActivities',
    modernApi: 'ActivityKit Live Activities (iOS 16.1+)',
    // ActivityKit Live Activities shipped in iOS 16.1; no Android equivalent
    // in the MVP, so the Android baseline is permanently false.
    platforms: {
      ios: { minOsVersion: 16 },
      android: { minOsVersion: null },
    },
    documentedFallback:
      'Render the in-tour status via the standard foreground notification ' +
      '(Android sticky notification, iOS local notification) instead of an ActivityKit widget. ' +
      'User-facing requirements (Req 12.x) remain satisfied.',
    rationale:
      'Req 15.2/15.3/15.4. Live Activities are an iOS-only enhancement; on platforms or ' +
      'OS versions without it, the legacy notification path is the documented fallback.',
  },
  foregroundServicePartialWakelock: {
    flag: 'foregroundServicePartialWakelock',
    modernApi: 'Android 14+ FOREGROUND_SERVICE_PARTIAL_WAKELOCK FGS type',
    // Android 14 (API 34) tightened FGS types and exposes the partial-wakelock
    // FGS type contract we want. iOS has no equivalent (its background-audio
    // path is governed by separate requirements).
    platforms: {
      ios: { minOsVersion: null },
      android: { minOsVersion: 34 },
    },
    documentedFallback:
      'On older Android, run the existing foreground service with a full wakelock ' +
      'and the location FGS type only. iOS uses background audio + significant location ' +
      'changes (Req 12.1, 12.2) which is unaffected by this flag.',
    rationale:
      'Req 15.2/15.3/15.4 + Req 12.1. Android-only flag controlling whether the ' +
      'foreground service can drop to a partial wakelock between approach windows.',
  },
  isolatedAudioFocus: {
    flag: 'isolatedAudioFocus',
    modernApi: '`AVAudioSession` isolated focus / `AudioFocusRequest` isolated-grant semantics',
    // iOS 14+ exposes the per-route audio session isolation we want; Android 12
    // (API 31) is the practical floor for `AudioFocusRequest` with the
    // takeAudioFocus semantics that match design.md Audio_Service.
    platforms: {
      ios: { minOsVersion: 14 },
      android: { minOsVersion: 31 },
    },
    documentedFallback:
      'Use the legacy AVAudioSession category / AudioFocusRequest path: request ' +
      'shared focus with ducking, accept that other apps may interrupt without ' +
      'isolated regain. Focus-loss handling (Req 10.1–10.4) still applies via the ' +
      "engine's audio focus events.",
    rationale:
      'Req 15.2/15.3/15.4 + Req 10.x. The flag selects between isolated and shared ' +
      'audio focus; both paths emit identical EngineEvents into the reducer.',
  },
  dynamicTypeXL: {
    flag: 'dynamicTypeXL',
    modernApi: 'Dynamic Type XL+ accessibility scales',
    // Dynamic Type XL-and-above accessibility sizes are a baseline iOS 13+ /
    // Android 11 (API 30) capability for the font-scale ranges we target.
    platforms: {
      ios: { minOsVersion: 13 },
      android: { minOsVersion: 30 },
    },
    documentedFallback:
      "Honor the user's standard text-size setting up to the platform default " +
      'maximum without the XL-and-above range. Layout still scales (Req 16.1) but ' +
      'without the additional accessibility multipliers.',
    rationale:
      'Req 15.2/15.3/15.4 + Req 16.1. Captioning and UI labels stay legible on the ' +
      'fallback path, satisfying the accessibility floor.',
  },
  secureEnclaveAvailable: {
    flag: 'secureEnclaveAvailable',
    modernApi: 'Secure Enclave-backed Keychain item (`kSecAttrTokenIDSecureEnclave`)',
    // Every iPhone 5s or newer ships a Secure Enclave; iOS 13 is the floor for
    // the CryptoKit-backed Keychain item class we rely on. No Android
    // counterpart for this exact flag (StrongBox is tracked separately).
    platforms: {
      ios: { minOsVersion: 13 },
      android: { minOsVersion: null },
    },
    documentedFallback:
      'Crypto_Service falls back to a software-only KDF + AES-GCM path; the ' +
      'hardware_secret still lives in the Keychain item class, just not bound to ' +
      'the Secure Enclave. Documented in design.md Capability_Layer + Crypto_Service.',
    rationale:
      'Req 21.4 + design.md Capability_Layer. Definitive answer requires a native ' +
      'Keychain probe (delivered by tasks 8.x); the OS-matrix value is a ' +
      'conservative upper bound until then.',
  },
  strongBoxAvailable: {
    flag: 'strongBoxAvailable',
    modernApi: 'Android Keystore StrongBox (`PackageManager.FEATURE_STRONGBOX_KEYSTORE`)',
    // PackageManager.FEATURE_STRONGBOX_KEYSTORE was added in Android 9 (API 28)
    // but practical / non-buggy support is API 29+ across the device fleet we
    // care about.
    platforms: {
      ios: { minOsVersion: null },
      android: { minOsVersion: 29 },
    },
    documentedFallback:
      'AndroidKeystore-only path without StrongBox; key generation runs without ' +
      'setIsStrongBoxBacked(true). Same software-only AEAD fallback as the iOS branch.',
    rationale:
      'Req 21.4 + design.md Capability_Layer. Definitive answer requires ' +
      '`PackageManager.hasSystemFeature(FEATURE_STRONGBOX_KEYSTORE)` via the native ' +
      'bridge in tasks 8.x.',
  },
  aesNiAccel: {
    flag: 'aesNiAccel',
    modernApi: 'CPU AES hardware acceleration (ARMv8 AES, x86 AES-NI)',
    // AES hardware acceleration is universal on ARMv8 (iPhone 5s+ / Android
    // 64-bit devices on API 21+). The matrix is informational only; nothing
    // gates correctness on this flag.
    platforms: {
      ios: { minOsVersion: 13 },
      android: { minOsVersion: 21 },
    },
    documentedFallback:
      'Informational flag only. When false, Crypto_Service still uses AES-GCM but ' +
      'sizes streaming chunk boundaries conservatively to avoid stalling on software ' +
      'AES paths. No engine behaviour changes.',
    rationale:
      'design.md Capability_Layer (informational). Used to size streaming AEAD chunk ' +
      'boundaries; not a correctness gate.',
  },
});

/** Convenience iterator over every flag declared in the matrix. */
export const ALL_CAPABILITY_FLAGS: ReadonlyArray<CapabilityFlag> = Object.freeze(
  Object.keys(OS_MATRIX) as CapabilityFlag[],
);

/**
 * Pure helper: given a platform + OS version, decide whether the matrix says
 * the modern path is available. Returns `false` when the platform has no
 * declared minimum (i.e. the capability is not offered on that platform) or
 * when the platform key is `unknown`.
 */
export function osMatrixSupports(
  flag: CapabilityFlag,
  platform: CapabilityPlatform,
  osVersion: number,
): boolean {
  if (platform === 'unknown') {
    return false;
  }
  const baseline: PerPlatformBaseline = OS_MATRIX[flag].platforms[platform];
  if (baseline.minOsVersion === null) {
    return false;
  }
  return osVersion >= baseline.minOsVersion;
}

/**
 * Build a frozen Capabilities snapshot from the static matrix only. This is
 * the conservative-baseline answer before any native probe contributes; it is
 * what the engine would see if every native probe declined to answer.
 */
export function osMatrixDefaults(
  platform: CapabilityPlatform,
  osVersion: number,
): Capabilities {
  const out: Record<CapabilityFlag, boolean> = {
    regionMonitoringV2: osMatrixSupports('regionMonitoringV2', platform, osVersion),
    liveActivities: osMatrixSupports('liveActivities', platform, osVersion),
    foregroundServicePartialWakelock: osMatrixSupports(
      'foregroundServicePartialWakelock',
      platform,
      osVersion,
    ),
    isolatedAudioFocus: osMatrixSupports('isolatedAudioFocus', platform, osVersion),
    dynamicTypeXL: osMatrixSupports('dynamicTypeXL', platform, osVersion),
    secureEnclaveAvailable: osMatrixSupports('secureEnclaveAvailable', platform, osVersion),
    strongBoxAvailable: osMatrixSupports('strongBoxAvailable', platform, osVersion),
    aesNiAccel: osMatrixSupports('aesNiAccel', platform, osVersion),
  };
  return Object.freeze(out);
}

// (No additional re-imports needed; types are imported at top of file.)
