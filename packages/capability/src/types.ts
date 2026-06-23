/**
 * Capability_Layer types (task 9.1).
 *
 * Per Requirements 15.2 / 15.3 / 15.4 and design.md "Capability_Layer" /
 * "Capability Layer Strategy", the Tour_Engine and command translators
 * consume *flags* — never raw OS versions. This file defines the shape of
 * those flags, their descriptors, and the optional native-side probe contract
 * that tasks 8.x will satisfy from their turbo modules.
 *
 * The flag set is the union mandated by:
 *   - Task 9.1 (the five engine-facing flags), and
 *   - design.md "Capability_Layer" (the three Crypto_Service-facing flags).
 *
 * `regionMonitoringV2`              — modern region monitoring path
 *                                     (CoreLocation `CLMonitor` on iOS 17+,
 *                                     `GeofencingClient` v2 on Android 12+).
 * `liveActivities`                  — iOS ActivityKit Live Activities.
 * `foregroundServicePartialWakelock`— Android 14+ partial-wakelock FGS contract.
 * `isolatedAudioFocus`              — `AVAudioSession` isolated focus / Android
 *                                     `AudioFocusRequest` with isolated-grant
 *                                     semantics.
 * `dynamicTypeXL`                   — XL+ accessibility text scales.
 * `secureEnclaveAvailable`          — iOS Secure Enclave usable for the
 *                                     Keychain item class Crypto_Service wants.
 * `strongBoxAvailable`              — Android `PackageManager.FEATURE_STRONGBOX_KEYSTORE`.
 * `aesNiAccel`                      — CPU has AES hardware acceleration
 *                                     (informational; sizes streaming AEAD chunks).
 */

/** Stable identifiers for every capability flag exposed by the Capability_Layer. */
export type CapabilityFlag =
  | 'regionMonitoringV2'
  | 'liveActivities'
  | 'foregroundServicePartialWakelock'
  | 'isolatedAudioFocus'
  | 'dynamicTypeXL'
  | 'secureEnclaveAvailable'
  | 'strongBoxAvailable'
  | 'aesNiAccel';

/**
 * Three-valued platform key. The MVP ships iOS + Android only; everything
 * else is `unknown` so the matrix routes to the documented fallback path
 * (Req 15.4).
 */
export type CapabilityPlatform = 'ios' | 'android' | 'unknown';

/**
 * Full capability snapshot. Engine code reads booleans only. The record is
 * frozen by `probeCapabilities()` / `defaultCapabilities()` so capability
 * decisions are stable for the duration of a session (design.md
 * "Capability Layer Strategy").
 */
export type Capabilities = Readonly<Record<CapabilityFlag, boolean>>;

/**
 * Per-platform baseline declared by the OS matrix. `minOsVersion === null`
 * means the capability has no native path on that platform: the static
 * default is therefore always `false` and only an explicit native override
 * can flip the flag to `true`.
 *
 * iOS uses the major marketing version (e.g. 17 for iOS 17.x). Android uses
 * the API level (e.g. 31 for Android 12) because that is what
 * `Platform.Version` returns at runtime.
 */
export interface PerPlatformBaseline {
  readonly minOsVersion: number | null;
}

/**
 * Static descriptor for one capability flag. Surfaced to downstream code so
 * tests (Property 18 in task 9.3) can introspect the documented fallback path
 * declared for each flag.
 */
export interface FlagDescriptor {
  readonly flag: CapabilityFlag;
  /** Native API or APIs gated by this flag, by name. */
  readonly modernApi: string;
  /**
   * Documented fallback path used when this flag is false. Mandatory per
   * Req 15.4 ("falls back to the documented legacy API path without
   * degrading active-tour functionality"). Must be non-empty.
   */
  readonly documentedFallback: string;
  /** Citation back to a requirement clause and / or design.md section. */
  readonly rationale: string;
  /** Per-platform baseline. iOS and Android only. */
  readonly platforms: Readonly<Record<'ios' | 'android', PerPlatformBaseline>>;
}

/**
 * Native-side probe shape. Tasks 8.x (Location_Service, Audio_Service,
 * TTS_Engine, Crypto_Service turbo modules) populate one or more of these
 * fields from native introspection (e.g.
 * `PackageManager.hasSystemFeature(FEATURE_STRONGBOX_KEYSTORE)` on Android,
 * a Keychain allocation probe on iOS). Any field left `undefined` means
 * "no native answer", and `probeCapabilities()` falls back to the OS-matrix
 * default for that flag.
 *
 * All fields are optional and read-only. A probe that explicitly answers
 * `false` overrides the matrix in either direction (e.g., a custom Android
 * image at API 31 may still report `strongBoxAvailable: false`).
 */
export interface NativeCapabilityProbe {
  readonly regionMonitoringV2?: boolean;
  readonly liveActivities?: boolean;
  readonly foregroundServicePartialWakelock?: boolean;
  readonly isolatedAudioFocus?: boolean;
  readonly dynamicTypeXL?: boolean;
  readonly secureEnclaveAvailable?: boolean;
  readonly strongBoxAvailable?: boolean;
  readonly aesNiAccel?: boolean;
}
