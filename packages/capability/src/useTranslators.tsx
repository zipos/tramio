/**
 * React hooks for capability-driven command translators (task 9.2).
 *
 * These hooks combine `useCapabilities()` with the translator dispatch
 * functions from `translators.ts`, providing a convenient API for React
 * components and the wiring layer (task 13.1).
 *
 * Usage pattern:
 *
 *     // In the wiring layer (task 13.1):
 *     import { useLocationTranslator } from '@tramio/capability';
 *
 *     function TourWiring() {
 *       const location = useLocationTranslator({
 *         modern: { armGeofences: armV2, disarmAll, setMode: setModeV2 },
 *         fallback: { armGeofences: armLegacy, disarmAll, setMode: setModeLegacy },
 *       });
 *
 *       // location.armGeofences(...) dispatches to modern or fallback
 *       // based on caps.regionMonitoringV2 — never on OS version.
 *     }
 *
 * Validates: Requirements 15.2, 15.3, 15.4
 */
import { useMemo } from 'react';

import { useCapabilities } from './useCapabilities';
import {
  audioTranslator,
  cryptoTranslator,
  foregroundServiceTranslator,
  locationTranslator,
} from './translators';
import type {
  AudioTranslatorActions,
  AudioTranslatorVariants,
  CryptoTranslatorActions,
  CryptoTranslatorVariants,
  ForegroundServiceTranslatorActions,
  ForegroundServiceTranslatorVariants,
  LocationTranslatorActions,
  LocationTranslatorVariants,
} from './translators';

/**
 * Hook: select the location translator path based on capability flags.
 *
 * Returns a stable `LocationTranslatorActions` reference (memoized on the
 * capabilities snapshot, which is immutable for the session lifetime).
 *
 * The hook NEVER reads `Platform.OS` or `Platform.Version` — only
 * `caps.regionMonitoringV2` via `dispatchByCapability`.
 */
export function useLocationTranslator(
  variants: LocationTranslatorVariants,
): LocationTranslatorActions {
  const caps = useCapabilities();
  return useMemo(() => locationTranslator(caps, variants), [caps, variants]);
}

/**
 * Hook: select the audio translator path based on capability flags.
 *
 * Returns a stable `AudioTranslatorActions` reference.
 *
 * The hook NEVER reads `Platform.OS` or `Platform.Version` — only
 * `caps.isolatedAudioFocus` via `dispatchByCapability`.
 */
export function useAudioTranslator(
  variants: AudioTranslatorVariants,
): AudioTranslatorActions {
  const caps = useCapabilities();
  return useMemo(() => audioTranslator(caps, variants), [caps, variants]);
}

/**
 * Hook: select the foreground service path based on capability flags.
 *
 * Returns a stable `ForegroundServiceTranslatorActions` reference.
 *
 * The hook NEVER reads `Platform.OS` or `Platform.Version` — only
 * `caps.foregroundServicePartialWakelock` via `dispatchByCapability`.
 */
export function useForegroundServiceTranslator(
  variants: ForegroundServiceTranslatorVariants,
): ForegroundServiceTranslatorActions {
  const caps = useCapabilities();
  return useMemo(() => foregroundServiceTranslator(caps, variants), [caps, variants]);
}

/**
 * Hook: select the crypto translator path based on capability flags.
 *
 * Returns a stable `CryptoTranslatorActions` reference.
 *
 * The hook NEVER reads `Platform.OS` or `Platform.Version` — only
 * `caps.secureEnclaveAvailable` and `caps.strongBoxAvailable` via
 * `dispatchByCapability`.
 */
export function useCryptoTranslator(
  variants: CryptoTranslatorVariants,
): CryptoTranslatorActions {
  const caps = useCapabilities();
  return useMemo(() => cryptoTranslator(caps, variants), [caps, variants]);
}
