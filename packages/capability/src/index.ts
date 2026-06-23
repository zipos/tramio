// @tramio/capability
//
// OS_MATRIX descriptor table + runtime capability probes for the flag set
// declared by task 9.1 and design.md "Capability_Layer":
//
//   - regionMonitoringV2
//   - liveActivities
//   - foregroundServicePartialWakelock
//   - isolatedAudioFocus
//   - dynamicTypeXL
//   - secureEnclaveAvailable    (Crypto_Service)
//   - strongBoxAvailable        (Crypto_Service)
//   - aesNiAccel                (Crypto_Service, informational)
//
// Engine code and command translators consume booleans from
// `probeCapabilities()` / `defaultCapabilities()`. OS-version comparisons
// stay inside this package (Req 15.2 / 15.3 / 15.4).
//
// Task 9.1: OS_MATRIX descriptor table + probeCapabilities().
// Task 9.2: `useCapabilities` React hook + `CapabilityProvider` +
//   `dispatchByCapability` helper + flag-driven command translators
//   (locationTranslator, audioTranslator, foregroundServiceTranslator,
//   cryptoTranslator) and their React hook wrappers.
// Task 9.3 will land Property 18 (capability fallback paths preserve
//   engine invariants).

export type {
  Capabilities,
  CapabilityFlag,
  CapabilityPlatform,
  FlagDescriptor,
  NativeCapabilityProbe,
  PerPlatformBaseline,
} from './types';

export {
  ALL_CAPABILITY_FLAGS,
  OS_MATRIX,
  osMatrixDefaults,
  osMatrixSupports,
} from './os-matrix';

export { defaultCapabilities, probeCapabilities } from './probes';

export type { CapabilityDispatchMapping, CapabilityVariants } from './dispatch';
export { dispatchByCapability } from './dispatch';

export type { CapabilityProviderProps } from './useCapabilities';
export { CapabilityProvider, useCapabilities } from './useCapabilities';

export type {
  AudioTranslatorActions,
  AudioTranslatorVariants,
  CryptoTranslatorActions,
  CryptoTranslatorVariants,
  ForegroundServiceTranslatorActions,
  ForegroundServiceTranslatorVariants,
  GeofenceInput,
  LocationModeInput,
  LocationTranslatorActions,
  LocationTranslatorVariants,
} from './translators';
export {
  audioTranslator,
  cryptoTranslator,
  foregroundServiceTranslator,
  locationTranslator,
} from './translators';

export {
  useAudioTranslator,
  useCryptoTranslator,
  useForegroundServiceTranslator,
  useLocationTranslator,
} from './useTranslators';
