/**
 * Flag-driven command translators (task 9.2).
 *
 * Per Requirements 15.2 / 15.3 / 15.4 and design.md "Capability_Layer" /
 * "Capability Layer Strategy", command translators MUST select the modern
 * vs fallback path purely from a `Capabilities` flag, never from
 * `Platform.OS` / `Platform.Version` directly.
 *
 * Each translator is a plain function that accepts a `Capabilities`
 * snapshot and returns the appropriate implementation (modern or fallback).
 * React components consume these via `useCapabilities()`:
 *
 *     const caps = useCapabilities();
 *     const armGeofences = locationTranslator(caps).armGeofences;
 *
 * The translators defined here are the *dispatch decision layer* only.
 * They do NOT contain the native call implementations themselves — those
 * live in `@tramio/native` (tasks 8.x) and are injected by the wiring
 * layer (task 13.1). This separation keeps the capability package free of
 * native dependencies and fully testable under fast-check (task 9.3).
 *
 * Validates: Requirements 15.2, 15.3, 15.4
 */
import { dispatchByCapability } from './dispatch';
import type { Capabilities } from './types';

// ---------------------------------------------------------------------------
// Location translator
// ---------------------------------------------------------------------------

/**
 * Location_Service command translator interface.
 *
 * The wiring layer (task 13.1) provides concrete implementations for
 * `modern` and `fallback` variants; this translator selects between them
 * based on `caps.regionMonitoringV2`.
 */
export interface LocationTranslatorActions {
  /**
   * Arm geofences using the selected path.
   * Modern: CLMonitor (iOS 17+) / GeofencingClient v2 (Android 12+).
   * Fallback: Legacy region monitoring with 20-region cap.
   */
  readonly armGeofences: (geofences: ReadonlyArray<GeofenceInput>) => void;
  /**
   * Disarm all geofences.
   * Both paths share the same disarm semantics.
   */
  readonly disarmAll: () => void;
  /**
   * Set the location pipeline mode.
   * Both paths share the same mode semantics.
   */
  readonly setMode: (mode: LocationModeInput) => void;
}

/** Minimal geofence shape consumed by the translator (avoids coupling to @tramio/engine). */
export interface GeofenceInput {
  readonly poiId: string;
  readonly geometry:
    | { readonly kind: 'circle'; readonly center: readonly [number, number]; readonly radiusMeters: number }
    | { readonly kind: 'polygon'; readonly vertices: ReadonlyArray<readonly [number, number]> };
  readonly dwellSec: number;
}

/** Location mode values the translator accepts. */
export type LocationModeInput = 'idle' | 'standby' | 'tour-bg' | 'tour-approach' | 'reconcile';

/**
 * Variants injected by the wiring layer for the location translator.
 * Each variant provides the full `LocationTranslatorActions` interface.
 */
export interface LocationTranslatorVariants {
  readonly modern: LocationTranslatorActions;
  readonly fallback: LocationTranslatorActions;
}

/**
 * Select the location translator path based on `caps.regionMonitoringV2`.
 *
 * - When `true`: uses CLMonitor / GeofencingClient v2 (modern path).
 * - When `false`: uses legacy region monitoring with 20-region cap (fallback).
 *
 * The translator NEVER checks OS version directly — only the capability flag.
 */
export function locationTranslator(
  caps: Capabilities,
  variants: LocationTranslatorVariants,
): LocationTranslatorActions {
  return dispatchByCapability(caps, {
    regionMonitoringV2: variants,
  });
}

// ---------------------------------------------------------------------------
// Audio translator
// ---------------------------------------------------------------------------

/**
 * Audio_Service command translator interface.
 *
 * The wiring layer provides concrete implementations for `modern` and
 * `fallback` variants; this translator selects between them based on
 * `caps.isolatedAudioFocus`.
 */
export interface AudioTranslatorActions {
  /**
   * Play a segment with the selected audio focus strategy.
   * Modern: isolated audio focus (per-route session isolation).
   * Fallback: shared focus with ducking.
   */
  readonly play: (segmentId: string, source: 'audio' | 'tts', prerollText?: string) => void;
  /** Pause the current segment and capture offset. */
  readonly pause: () => void;
  /** Resume from a captured offset. */
  readonly resume: (offsetMs: number) => void;
  /** Stop audio and release focus. */
  readonly stop: () => void;
}

/**
 * Variants injected by the wiring layer for the audio translator.
 */
export interface AudioTranslatorVariants {
  readonly modern: AudioTranslatorActions;
  readonly fallback: AudioTranslatorActions;
}

/**
 * Select the audio translator path based on `caps.isolatedAudioFocus`.
 *
 * - When `true`: uses isolated audio focus (AVAudioSession per-route
 *   isolation on iOS 14+, AudioFocusRequest isolated-grant on Android 12+).
 * - When `false`: uses shared focus with ducking (legacy path).
 *
 * The translator NEVER checks OS version directly — only the capability flag.
 */
export function audioTranslator(
  caps: Capabilities,
  variants: AudioTranslatorVariants,
): AudioTranslatorActions {
  return dispatchByCapability(caps, {
    isolatedAudioFocus: variants,
  });
}

// ---------------------------------------------------------------------------
// Foreground service translator (Android only)
// ---------------------------------------------------------------------------

/**
 * Foreground service command translator interface.
 *
 * Controls whether the Android foreground service uses the partial-wakelock
 * FGS type (Android 14+) or the legacy full-wakelock path.
 */
export interface ForegroundServiceTranslatorActions {
  /**
   * Start the foreground service with the selected wakelock strategy.
   * Modern: partial wakelock between approach windows (Android 14+).
   * Fallback: full wakelock + location FGS type only.
   */
  readonly startForegroundService: () => void;
  /** Stop the foreground service. */
  readonly stopForegroundService: () => void;
}

/**
 * Variants injected by the wiring layer for the foreground service translator.
 */
export interface ForegroundServiceTranslatorVariants {
  readonly modern: ForegroundServiceTranslatorActions;
  readonly fallback: ForegroundServiceTranslatorActions;
}

/**
 * Select the foreground service path based on
 * `caps.foregroundServicePartialWakelock`.
 *
 * - When `true`: uses FOREGROUND_SERVICE_PARTIAL_WAKELOCK FGS type (Android 14+).
 * - When `false`: uses full wakelock + location FGS type (legacy).
 *
 * On iOS this flag is always `false` (per OS_MATRIX) and the fallback is a
 * no-op since iOS uses background audio mode instead.
 *
 * The translator NEVER checks OS version directly — only the capability flag.
 */
export function foregroundServiceTranslator(
  caps: Capabilities,
  variants: ForegroundServiceTranslatorVariants,
): ForegroundServiceTranslatorActions {
  return dispatchByCapability(caps, {
    foregroundServicePartialWakelock: variants,
  });
}

// ---------------------------------------------------------------------------
// Crypto translator
// ---------------------------------------------------------------------------

/**
 * Crypto_Service command translator interface.
 *
 * Controls whether the hardware-backed secret is stored in a secure element
 * (Secure Enclave on iOS, StrongBox on Android) or falls back to the
 * software-only Keychain/Keystore path.
 */
export interface CryptoTranslatorActions {
  /**
   * Ensure the hardware-backed secret exists.
   * Modern: bound to Secure Enclave / StrongBox.
   * Fallback: software-only Keychain / Keystore.
   */
  readonly ensureHardwareSecret: () => Promise<void>;
  /**
   * Open a decrypted stream for an encrypted asset.
   * Both paths use AES-256-GCM; the difference is where the key material lives.
   */
  readonly openDecryptedStream: (encAssetPath: string) => Promise<unknown>;
}

/**
 * Variants injected by the wiring layer for the crypto translator.
 * Two flags are relevant: `secureEnclaveAvailable` (iOS) and
 * `strongBoxAvailable` (Android). The translator composes two dispatch
 * calls — one per flag — and merges the results.
 */
export interface CryptoTranslatorVariants {
  readonly secureEnclave: {
    readonly modern: CryptoTranslatorActions;
    readonly fallback: CryptoTranslatorActions;
  };
  readonly strongBox: {
    readonly modern: CryptoTranslatorActions;
    readonly fallback: CryptoTranslatorActions;
  };
}

/**
 * Select the crypto translator path based on `caps.secureEnclaveAvailable`
 * (iOS) or `caps.strongBoxAvailable` (Android).
 *
 * Since only one of these flags can be `true` at a time (they are
 * platform-exclusive per the OS_MATRIX), the translator checks both and
 * returns the first modern path that matches, falling back to the
 * software-only path if neither secure element is available.
 *
 * The translator NEVER checks OS version directly — only capability flags.
 */
export function cryptoTranslator(
  caps: Capabilities,
  variants: CryptoTranslatorVariants,
): CryptoTranslatorActions {
  // Check Secure Enclave first (iOS path).
  const fromSecureEnclave = dispatchByCapability(caps, {
    secureEnclaveAvailable: variants.secureEnclave,
  });

  // Check StrongBox (Android path).
  const fromStrongBox = dispatchByCapability(caps, {
    strongBoxAvailable: variants.strongBox,
  });

  // If either secure element is available, use its modern path.
  // Since the flags are platform-exclusive, at most one will be `true`.
  if (caps.secureEnclaveAvailable) {
    return fromSecureEnclave;
  }
  if (caps.strongBoxAvailable) {
    return fromStrongBox;
  }

  // Neither secure element available — both dispatches returned fallback.
  // Return either (they should be equivalent software-only paths).
  return fromSecureEnclave;
}
