# @tramio/capability

Capability_Layer for the Tour_Engine. The engine consumes capability flags
rather than OS versions, so newer surfaces (region monitoring v2, Live
Activities, partial-wakelock foreground services, isolated audio focus,
Secure Enclave / StrongBox) can be enabled without reshaping the engine
(Req 15.2 / 15.3 / 15.4).

## What this package exposes

- `OS_MATRIX` — static `FlagDescriptor` table per platform (iOS / Android)
  and OS version, with a documented fallback path per flag.
- `probeCapabilities(platform, osVersion, native?)` — pure function that
  combines the matrix defaults with optional native probe results and
  returns a frozen `Capabilities` record.
- `defaultCapabilities()` — conservative-baseline `Capabilities` record
  (every flag `false`). Useful for unit tests.
- `NativeCapabilityProbe` — TypeScript interface that tasks 8.x will
  satisfy from their turbo modules to replace heuristic answers with real
  device probes.

## Flags

| Flag                               | iOS floor | Android floor | Modern API                                                                          |
| ---------------------------------- | --------- | ------------- | ----------------------------------------------------------------------------------- |
| `regionMonitoringV2`               | iOS 17    | API 31        | CoreLocation `CLMonitor` / `GeofencingClient` v2                                    |
| `liveActivities`                   | iOS 16    | —             | ActivityKit Live Activities                                                         |
| `foregroundServicePartialWakelock` | —         | API 34        | `FOREGROUND_SERVICE_PARTIAL_WAKELOCK` FGS type                                      |
| `isolatedAudioFocus`               | iOS 14    | API 31        | `AVAudioSession` isolated focus / `AudioFocusRequest` isolated-grant                |
| `dynamicTypeXL`                    | iOS 13    | API 30        | Dynamic Type XL+ accessibility scales                                               |
| `secureEnclaveAvailable`           | iOS 13    | —             | Secure Enclave-backed Keychain item                                                 |
| `strongBoxAvailable`               | —         | API 29        | `PackageManager.FEATURE_STRONGBOX_KEYSTORE`                                         |
| `aesNiAccel`                       | iOS 13    | API 21        | CPU AES hardware acceleration (informational)                                       |

Each flag's `documentedFallback` is mandatory and surfaced via
`OS_MATRIX[flag].documentedFallback` so downstream code (and the property
suite for task 9.3) can introspect it.

## Status

- Task 9.1 — OS_MATRIX + `probeCapabilities` + `defaultCapabilities` + smoke
  tests: done.
- Task 9.2 — `useCapabilities` hook + flag-driven dispatch in command
  translators: pending.
- Task 9.3 — Property 18 (capability fallback paths preserve engine
  invariants): pending.
