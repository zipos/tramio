# Implementation Plan: Urban Narrative MVP

## Overview

Implementation proceeds bottom-up. The Authoring_Schema validator and the pure Tour_Engine reducer are stood up first so most universal properties (P1–P12) become testable before any native code or UI is written. Native turbo modules (Location_Service, Audio_Service, TTS_Engine) and Storage_Manager are built behind the same TypeScript interfaces the engine already targets. Catalog_Client, Entitlement_Client, and a minimal self-hosted backend follow, then MapLibre with offline tiles, then UI flows. The Capability_Layer is wired late so its fallback paths are validated against the existing engine property suite (P18). A single sample Content_Bundle is authored as the integration fixture.

The application code is TypeScript on Expo bare React Native. The validator is also a Node CLI. Property-based tests use fast-check.

## Tasks

- [x] 1. Bootstrap project workspace

  - [x] 1.1 Initialize Expo bare RN + TypeScript app at the repository root

    - Run Expo bare template, configure TypeScript strict mode, configure EAS Build profile for iOS and Android
    - Add background modes (audio, location) to iOS `Info.plist`; declare runtime permissions and foreground service in `AndroidManifest.xml`
    - _Requirements: 12.1, 12.2, 12.4, 15.1_

  - [x] 1.2 Configure tooling (ESLint, Prettier, Jest, fast-check, Husky)

    - Pin fast-check, Jest, ts-node, ts-jest; wire `numRuns >= 100` and a fixed CI seed; tag template `Feature: urban-narrative-mvp, Property {n}: {short title}`
    - _Requirements: none (infrastructure)_

  - [x] 1.3 Lay out source tree for module boundaries
    - Create `packages/authoring/`, `packages/engine/`, `packages/storage/`, `packages/clients/`, `packages/native/`, `packages/capability/`, `packages/map/`, `packages/ui/`, `packages/backend/`, `fixtures/`
    - Each package has its own `package.json`, `tsconfig.json`, and Jest config
    - _Requirements: none (infrastructure)_

- [x] 2. Authoring_Schema and Content_Bundle validator

  - [x] 2.1 Define TypeScript types and JSON Schema 2020-12 for Content_Bundle

    - Schemas for `manifest.json`, `route.json`, `pois.json`, narrative Markdown frontmatter, standby track JSON
    - Encode entitlement tier enum `{free, time_pass, token_unlock, b2b}`, language keying on ISO 639-1, B2B `sponsor` + `disclosure` requirement, CC license `id` + `attribution` requirement, transcript-required-with-audio rule
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7, 14.1, 14.5, 16.3, 17.2_

  - [x] 2.2 Implement Content_Bundle validator with cross-file invariants

    - Validate JSON Schema, then resolve every POI narrative reference, every audio asset, every transcript pair, every CC license entry
    - Return either `LoadedBundle` or `BundleValidationError { filePath, jsonPointer, message, hint }`
    - _Requirements: 2.4, 2.5, 14.5, 16.3, 17.2, 20.4_

  - [x] 2.3 Implement `bundle-validate` CLI for the authoring harness

    - Command-line entry point that runs the validator on a directory and exits non-zero with a human-readable error message identifying the offending field path
    - _Requirements: 2.5_

  - [x] 2.4 Write property test for the Authoring_Schema validator

    - **Property 13: Authoring_Schema validator rejects all violations and accepts all conforming bundles**
    - Generator: take a known-valid bundle and mutate exactly one constraint per run (drop required field, retype, out-of-range value, drop transcript for pre-rendered audio, drop license for CC content, drop disclosure for B2B); assert validator rejects and produces an error pointing to the offending file path and JSON pointer; assert unmutated bundle is accepted
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 14.1, 16.3, 17.2**

  - [x] 2.5 Write unit tests for known-good and known-bad bundle fixtures
    - One fixture per discriminated error class (missing transcript, missing disclosure, etc.)
    - _Requirements: 2.4, 2.5_

- [ ] 3. Tour_Engine pure reducer

  - [x] 3.1 Define EngineEvent, EngineCommand, TourState, AcceptedUpdate, Geofence, Entitlement types

    - Match the type definitions in design.md verbatim
    - _Requirements: 1.1, 5.5, 13.2, 14.2, 15.1_

  - [x] 3.2 Implement geofence filtering pipeline

    - Stages 1 and 2 (accuracy gate >50 m reject, spike rejection >120 km/h) implemented in TS for testability with a parallel native interface
    - Stages 3, 4, 5 (EMA smoothing over last 3 accepted updates, dwell accumulator, direction filter via along-route projection)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 3.3 Write property test for the geofence filtering pipeline (accuracy + spike)

    - **Property 1: Geofence pipeline rejects low-accuracy and spike updates**
    - **Validates: Requirements 5.1, 5.2**

  - [x] 3.4 Write property test for dwell + direction triggering

    - **Property 2: Trigger requires dwell and direction match**
    - **Validates: Requirements 5.3, 5.4, 5.5**

  - [x] 3.5 Implement state machine (Idle, Active, Standby, DeadReckoning, Deviation, Ended) and consumed-set tracking

    - Single-segment invariant `|playing| <= 1`; consumed POIs short-circuit before stage 4 of the pipeline
    - Tour-end resource release within 2 seconds via `ReleaseAll` command
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.7, 7.3, 8.3_

  - [x] 3.6 Write property test for single-segment + no-replay invariant

    - **Property 3: At most one segment plays at any time and no POI plays twice in a session**
    - **Validates: Requirements 1.3, 1.4, 1.5, 7.3, 8.3**

  - [x] 3.7 Implement priority comparator for overlapping POI triggers

    - Comparator with declared tie-breakers; lower-priority overlapping POIs marked skipped per authored ordering
    - _Requirements: 1.6_

  - [ ] 3.8 Write property test for priority comparator

    - **Property 4: Priority comparator selects the played segment when triggers overlap**
    - **Validates: Requirements 1.6**

  - [ ] 3.9 Implement Dead_Reckoning entry, advance, and reconciliation

    - Enter DR after 15 seconds without an accepted update; estimate along-route position from last known + GTFS schedule + elapsed time
    - On accepted update return, reconcile: replay highest-priority deferrable missed POI, mark others skipped
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ] 3.10 Write property test for DR estimate monotonicity and bound

    - **Property 5: Dead-reckoning estimate is monotonic and bounded by next-stop scheduled arrival**
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [ ] 3.11 Write property test for DR reconciliation

    - **Property 6: Reconciliation after dead-reckoning preserves single-fire and plays only the highest-priority deferrable missed POI**
    - **Validates: Requirements 6.4, 6.5**

  - [ ] 3.12 Implement Standby_Track scheduling

    - Enter Standby after 30 s of smoothed speed <3 km/h with nothing playing; pause within 1 s of resumed motion or POI dwell-trigger; remain silent if no Standby_Track exists
    - _Requirements: 7.1, 7.2, 7.4_

  - [ ] 3.13 Write property test for Standby_Track behavior

    - **Property 7: Standby_Track behavior is bounded by motion and POI events**
    - **Validates: Requirements 7.1, 7.2, 7.4**

  - [ ] 3.14 Implement Route_Deviation classification and resume corridor

    - Classify deviation when smoothed position is >150 m from polyline for 60 continuous seconds; resume only on user `resume-route` command AND smoothed position within 75 m corridor; auto-end after 5 minutes of no response
    - Suppress POI triggers while deviation prompt is pending
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ] 3.15 Write property test for deviation classification and resume

    - **Property 8: Route deviation classification and resume corridor**
    - **Validates: Requirements 8.1, 8.4**

  - [ ] 3.16 Implement audio source selection with language fallback

    - Pre-rendered audio if exists in selected language; otherwise TTS on the narrative Markdown in that language; otherwise fall back to bundle's `defaultLanguage`
    - _Requirements: 9.1, 9.2, 9.5_

  - [ ] 3.17 Write property test for audio source selection

    - **Property 9: Audio source selection follows pre-rendered availability and language fallback**
    - **Validates: Requirements 9.1, 9.2, 9.5**

  - [ ] 3.18 Implement audio focus loss/regain handling in the engine

    - Pause + record offset on focus loss; resume from offset on regain; discard offset and skip auto-resume if gap exceeds 10 minutes
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [ ] 3.19 Write property test for focus-loss resume

    - **Property 10: Focus-loss resume is correct and time-bounded**
    - **Validates: Requirements 10.1, 10.2, 10.3**

  - [ ] 3.20 Implement entitlement-aware playback filtering and B2B disclosure pre-roll

    - Consult cached entitlement set for Device_Id; honor time-pass only while UTC expiry is in future; play deeper layers when token granted; refuse B2B without sponsor + disclosure or when moderation marks segment disabled; emit disclosure pre-roll command before B2B audio
    - _Requirements: 13.2, 13.3, 14.2, 14.3, 14.4, 14.5, 14.6, 20.1, 20.2, 20.3, 20.4_

  - [ ] 3.21 Write property test for entitlement-aware playback monotonicity

    - **Property 11: Entitlement-aware playback is monotonic in entitlements**
    - **Validates: Requirements 14.2, 14.3, 14.4**

  - [ ] 3.22 Write property test for B2B disclosure-and-moderation invariant
    - **Property 12: B2B disclosure-and-moderation invariant**
    - **Validates: Requirements 14.5, 14.6, 20.1, 20.2, 20.3, 20.4**

- [ ] 4. Checkpoint - engine and validator complete

  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Storage_Manager and Offline_Pack downloader

  - [x] 5.1 Implement filesystem layout, SQLite schema, and atomic-rename primitives

    - Pack store at `${docs}/packs/{bundleId}/{version}/`; staging directory `{version}.staging/`; SQLite tables for `pack_progress`, `entitlement_cache`, `lru_access`, `moderation_snapshot`, `device_id`
    - Stage + rename helpers; SHA-256 streaming verifier
    - _Requirements: 3.1, 3.5, 13.1, 19.5_

  - [x] 5.2 Implement Offline_Pack downloader with streaming verification and resume table

    - Fetch lock file; download assets in dependency order (manifest → route → POIs → narratives → audio → tiles); each `.part` file renamed only after SHA-256 matches; `pack_progress.status ∈ {pending, partial, complete}`; resume skips assets whose on-disk SHA-256 still matches
    - Refuse to mark a pack startable until every asset is `complete`
    - _Requirements: 3.1, 3.3, 3.4, 3.5_

  - [x] 5.3 Write property test for the download/resume round trip

    - **Property 14: Offline_Pack download/resume round trip preserves content and avoids re-fetching**
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5**

  - [x] 5.4 Implement storage budget enforcement, LRU eviction, and storage UI data source

    - Default 2 GB ceiling; manual mode prompts the user; auto-evict mode evicts least-recently-used packs first; never evict the active-tour pack
    - Expose total used and remaining for the storage management screen
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5_

  - [x] 5.5 Write property test for storage budget under add and evict
    - **Property 17: Storage budget policy is correct under add and evict**
    - **Validates: Requirements 19.2, 19.3, 19.4**

- [ ] 6. Backend stubs, Catalog_Client, Entitlement_Client

  - [x] 6.1 Implement minimal self-hosted backend (Fastify) with the API surface from design.md

    - `GET /v1/catalog`, `GET /v1/catalog/{bundleId}/{version}/manifest.lock.json`, `GET /v1/catalog/{bundleId}/{version}/asset/{path}` (range-supported), `GET /v1/gtfs/{cityId}/latest`, `GET /v1/entitlements`, `POST /v1/entitlements/receipt`, `POST /v1/entitlements/restore`, `GET /v1/moderation`
    - All responses signed with a long-lived key; public part shipped in client
    - _Requirements: 3.1, 3.4, 3.6, 13.2, 13.4, 13.5, 14.6, 18.1, 18.2, 20.3_

  - [x] 6.2 Implement HTTP client wrapper that blocks outbound requests during an active tour

    - Single chokepoint reads `engine.isTourActive`; throws or no-ops on outbound calls except loopback/IPC
    - Honor metered/unmetered policy for catalog probes and pack downloads
    - _Requirements: 3.2, 3.6, 18.2_

  - [x] 6.3 Write property test for "no cellular network calls during an active tour"

    - **Property 15: No cellular network calls during an active tour**
    - **Validates: Requirements 3.2**

  - [x] 6.4 Implement Catalog_Client (probe, lock fetch, ranged asset fetch, moderation refresh)

    - Reads through Storage_Manager; surfaces "update available" without auto-downloading on metered
    - _Requirements: 3.6, 14.6, 18.1, 20.3_

  - [x] 6.5 Implement Entitlement_Client with Device_Id management and signed cache

    - Generate Device_Id on first launch, persist in secure storage; resolve entitlements via `/v1/entitlements`; cache with declared expiry; receipt validation idempotent on `(deviceId, platformReceiptId)`; honor cached entitlement only while now ≤ expiry; never require email/phone/social
    - During active tour, read from cache only
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 14.2, 14.3_

  - [ ] 6.6 Write property test for Device_Id stability + offline entitlement honoring

    - **Property 20: Device_Id stability and offline entitlement honoring**
    - **Validates: Requirements 13.1, 13.3**

  - [x] 6.7 Write integration tests for backend stubs
    - Spin up Fastify in-process; verify each endpoint contract and signature verification
    - _Requirements: 3.6, 13.2, 13.4, 13.5, 14.6, 18.1, 20.3_

- [ ] 7. GTFS feed support

  - [x] 7.1 Implement GTFS feed parser, schedule lookup for active line, and atomic feed replacement

    - Parse stops/stop_times/trips/calendar; expose `scheduledOffsetSec` lookups consumed by Tour_Engine DR
    - Atomic rename on update over an unmetered connection
    - _Requirements: 4.2, 4.3, 6.2, 18.1, 18.2_

  - [x] 7.2 Implement GTFS age policy enforcement

    - Compute feed age in days; expose flags `staleWarning` (`A > 30`) and `drDisabled` (`A > 90`); engine consumes `drDisabled` to suppress entry to DeadReckoning
    - Surface non-blocking warning to UI when stale and a stronger warning when DR is disabled
    - _Requirements: 18.3, 18.4_

  - [x] 7.3 Write property test for GTFS-age policy
    - **Property 16: GTFS-age policy controls warnings and dead-reckoning availability**
    - **Validates: Requirements 18.3, 18.4**

- [ ] 8. Native turbo modules

  - [x] 8.1 Scaffold Location_Service turbo module and implement iOS native side

    - TypeScript spec with `setMode`, `armGeofences`, `disarmAll`, events `onAccepted`, `onRejected`, `onGeofenceEnter/Dwell/Exit`, `onAccuracyChanged`
    - iOS: `CLLocationManager` region monitoring + significant location changes + foreground high-accuracy windows; native accuracy gate (>50 m reject) and spike rejection (>120 km/h reject); sliding region window of N nearest POIs to respect the 20-region cap
    - User-visible high-accuracy indicator hook
    - _Requirements: 5.1, 5.2, 11.1, 11.2, 11.3, 11.4, 11.5, 12.2, 12.3, 15.1_

  - [x] 8.2 Implement Android Location_Service native side

    - `FusedLocationProviderClient` with `Priority.HIGH_ACCURACY` for approach windows and `Priority.BALANCED_POWER_ACCURACY` between windows; `GeofencingClient` with DWELL+ENTER `PendingIntent`; foreground service with sticky notification; native accuracy gate and spike rejection
    - _Requirements: 5.1, 5.2, 11.2, 11.3, 11.4, 11.5, 12.1, 12.2, 12.3, 15.1_

  - [x] 8.3 Scaffold Audio_Service turbo module and implement iOS native side

    - TypeScript spec with sequential play of one segment, pause/resume with offset, volume normalization to ~-16 LUFS ±3 dB, ducking at ≥50%, focus loss/regain events
    - iOS: `AVAudioPlayer` + `AVAudioSession` background audio mode
    - _Requirements: 9.3, 10.1, 10.2, 10.3, 10.4, 12.1, 15.1_

  - [x] 8.4 Implement Android Audio_Service native side

    - `ExoPlayer` + `AudioFocusRequest` (transient gain, duck, loss); LUFS normalization; ducking ≥50%
    - _Requirements: 9.3, 10.1, 10.2, 10.3, 10.4, 12.1, 15.1_

  - [x] 8.5 Scaffold TTS_Engine turbo module and implement iOS native side

    - iOS: `AVSpeechSynthesizer`; resolve `(language, region)` with documented fallback chain; emit playback events shaped like Audio_Service's
    - On missing voice: fall back to platform default for language and log a non-fatal warning
    - _Requirements: 9.2, 9.4, 15.1_

  - [x] 8.6 Implement Android TTS_Engine native side

    - `android.speech.tts.TextToSpeech` with the same fallback chain; same playback event shape
    - _Requirements: 9.2, 9.4, 15.1_

  - [x] 8.7 Write instrumented smoke tests for native modules
    - One iOS and one Android device test per module verifying basic event flow, background audio, and geofence wake
    - _Requirements: 1.7, 9.3, 10.1, 12.1, 12.2, 12.3_

- [ ] 9. Capability_Layer

  - [x] 9.1 Implement OS_MATRIX descriptor table and runtime capability probes

    - Flags `regionMonitoringV2`, `liveActivities`, `foregroundServicePartialWakelock`, `isolatedAudioFocus`, `dynamicTypeXL`
    - Each flag has a documented fallback path
    - _Requirements: 15.2, 15.3, 15.4_

  - [x] 9.2 Implement `useCapabilities` hook and flag-driven dispatch in command translators

    - Translators select modern vs fallback paths based on flags, never on OS version directly
    - _Requirements: 15.2, 15.3, 15.4_

  - [ ] 9.3 Write property test for capability fallback paths
    - **Property 18: Capability fallback paths preserve engine invariants**
    - Parameterize the engine property suite (P1, P2, P3, P5, P6) by capability set; assert all hold under each fallback configuration
    - **Validates: Requirements 15.2, 15.3, 15.4**

- [ ] 10. MapLibre map layer with offline tiles

  - [x] 10.1 Integrate MapLibre GL Native and wire offline vector tile source through Storage_Manager

    - No outbound tile requests during active tour; tiles served from `${docs}/packs/{bundleId}/{version}/tiles/`
    - _Requirements: 3.2, 4.1, 4.4_

  - [ ] 10.2 Render OpenStreetMap attribution overlay on every map view

    - Persistent overlay component used by every screen that mounts a map
    - _Requirements: 4.5, 17.1, 17.4_

  - [ ] 10.3 Write snapshot test asserting OSM attribution renders on every map view
    - _Requirements: 17.4_

- [ ] 11. UI flows

  - [ ] 11.1 Implement route selection screen

    - Lists installed Content_Bundles; disables "Start" for partial packs and shows missing-asset count
    - All interactive elements expose VoiceOver/TalkBack labels and respect dynamic type
    - _Requirements: 1.1, 3.5, 16.1, 16.5_

  - [ ] 11.2 Implement tour playback screen with caption display, playback speed control, and high-accuracy indicator

    - Synchronized caption rendering against the authored caption timeline; playback speed exactly `{0.75, 1.0, 1.25, 1.5}`; visible indicator when location mode is `tour-approach` or `reconcile`
    - _Requirements: 11.5, 16.1, 16.2, 16.4, 16.5, 17.3_

  - [ ] 11.3 Write property test for captions and playback speed set

    - **Property 19: Captions and playback speed conform to authoring and accessibility rules**
    - **Validates: Requirements 16.2, 16.4**

  - [ ] 11.4 Implement deviation prompt UI

    - Modal offering Resume / Switch / End; auto-dismiss + tour-end after 5 minutes of no response
    - _Requirements: 8.2, 8.5, 16.1_

  - [ ] 11.5 Implement storage management screen

    - Budget setting (default 2 GB), per-pack list with size and last-access, remove/evict actions, totals; respects "never evict active-tour pack" rule
    - _Requirements: 19.1, 19.2, 19.5_

  - [ ] 11.6 Implement attribution screen

    - Lists OpenStreetMap, MapLibre, and every CC source declared in installed bundles
    - _Requirements: 17.1, 17.2, 17.3_

  - [ ] 11.7 Implement Sponsored indicator and disclosure pre-roll UI
    - Visible "Sponsored" badge for the entire B2B segment; disclosure rendered/spoken before audio begins
    - _Requirements: 20.1, 20.2_

- [ ] 12. Checkpoint - services, native modules, and screens shipped

  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Wiring and integration

  - [ ] 13.1 Wire Tour_Engine to Location_Service, Audio_Service, TTS_Engine via command translators

    - Translators consume `RequestLocationMode`, `PlaySegment`, `PauseAudio`, `ResumeAudio`, `StopAudio`, `ScheduleTimer`, `CancelTimer`, `ReleaseAll`; forward native events back as `EngineEvent`s
    - _Requirements: 1.7, 5.1, 9.1, 9.2, 11.2, 11.3, 12.1, 12.2, 15.1_

  - [ ] 13.2 Wire Tour_Engine to Storage_Manager, Catalog_Client, Entitlement_Client

    - Engine reads bundle assets and entitlement cache via commands only; never opens sockets or files directly
    - _Requirements: 3.2, 13.2, 13.3, 14.2, 14.6_

  - [ ] 13.3 Wire UI screens to engine state and commands

    - State subscriptions for playback, deviation prompt visibility, high-accuracy indicator, Sponsored badge
    - User commands (`start`, `end`, `resume-route`, `switch-route`, `dismiss`) emitted from UI into the engine
    - _Requirements: 1.1, 1.7, 8.2, 8.5, 11.5, 16.1, 17.3, 20.1, 20.2_

  - [ ] 13.4 Write trace-replay integration tests
    - Deterministic CSV replay through the JS half of the pipeline + engine with mocked native services
    - Scenarios: clean ride, tunnel (90 s signal loss), traffic stop (2 min zero motion), deviation, spike storm, overlapping geofences with varied priorities
    - Each scenario asserts a chosen property over the resulting command stream
    - _Requirements: 5.1, 5.2, 6.1, 6.4, 7.1, 8.1, 1.6_

- [ ] 14. Sample Content_Bundle integration fixture

  - [ ] 14.1 Author one-route Content_Bundle for the target city

    - `manifest.json`, `route.json`, `pois.json`, narrative Markdown in at least the default language plus one secondary, optional pre-rendered audio for one hero POI with transcript, two standby tracks, vector tiles covering the route corridor, OSM/CC attribution entries, one B2B segment with sponsor + disclosure
    - _Requirements: 1.1, 1.6, 2.1, 2.2, 2.3, 2.6, 7.1, 9.1, 9.2, 14.1, 14.5, 16.3, 17.2_

  - [ ] 14.2 Generate `MANIFEST.lock.json` and host on the local backend stub

    - Lock file produced by the catalog tool; backend serves bundle assets via `/v1/catalog/{bundleId}/{version}/...`
    - _Requirements: 3.1, 3.4_

  - [ ] 14.3 Write end-to-end integration test replaying the sample bundle through the engine
    - Download pack via Storage_Manager, validate, start tour, replay a clean trace, assert command stream matches expected POI sequence
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 3.1, 3.3_

- [ ] 15. Final checkpoint - all property and integration tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they cover unit, property, and integration tests.
- Each task references specific requirement clauses and (for test tasks) the exact correctness property from design.md.
- The Tour_Engine reducer is implemented before native modules so Properties 1–12 are testable end-to-end against the JS half of the pipeline before any native code lands.
- Property 18 (capability fallback) reuses Properties 1, 2, 3, 5, 6 parameterized by capability set, so it depends on the engine property suite already being in place.
- Property 15 (no cellular during tour) is enforced at a single HTTP chokepoint and tested by counting outbound calls during a simulated active tour.
- Instrumented device tests (8.7\*) cover requirements that fast-check cannot meaningfully validate: tour-end latency (1.7), volume normalization (9.3), focus-loss pause latency (10.1), and background geofence wake (12.x).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1", "9.1"] },
    { "id": 3, "tasks": ["2.2", "3.2", "5.1", "6.1", "8.1", "8.3", "8.5"] },
    { "id": 4, "tasks": ["2.3", "5.2", "6.2", "7.1", "8.2", "8.4", "8.6", "9.2"] },
    {
      "id": 5,
      "tasks": ["2.4", "2.5", "3.3", "3.4", "3.5", "5.3", "5.4", "6.3", "6.4", "7.2", "8.7"]
    },
    { "id": 6, "tasks": ["3.6", "3.7", "5.5", "6.5", "6.7", "7.3", "10.1"] },
    { "id": 7, "tasks": ["3.8", "3.9", "6.6", "10.2"] },
    { "id": 8, "tasks": ["3.10", "3.11", "3.12", "10.3"] },
    { "id": 9, "tasks": ["3.13", "3.14", "11.1", "11.4", "11.5", "11.6", "11.7"] },
    { "id": 10, "tasks": ["3.15", "3.16", "11.2"] },
    { "id": 11, "tasks": ["3.17", "3.18", "11.3"] },
    { "id": 12, "tasks": ["3.19", "3.20"] },
    { "id": 13, "tasks": ["3.21", "3.22", "9.3"] },
    { "id": 14, "tasks": ["13.1"] },
    { "id": 15, "tasks": ["13.2"] },
    { "id": 16, "tasks": ["13.3"] },
    { "id": 17, "tasks": ["13.4", "14.1"] },
    { "id": 18, "tasks": ["14.2"] },
    { "id": 19, "tasks": ["14.3"] }
  ]
}
```
