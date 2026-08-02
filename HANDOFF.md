# Tramio — Engineering Handoff

> **IDE-agnostic.** This document is the single source of truth for any
> developer or AI coding assistant (Cursor, Antigravity, Copilot, Claude
> Code, Zed, plain editors, etc.) picking up this project. It assumes no
> particular tool. When you make a meaningful change, update the relevant
> section so the next contributor stays oriented.

## Purpose

Describes what has been built, the current runtime architecture, what
remains, and how to build/run the app — so work can be handed off cleanly
between sessions, contributors, or tools.

## Project Overview

**Tramio** is a React Native (Expo bare) app that turns regular city transit
rides into geofenced audio-guided tours. The user boards a bus/tram, starts a
tour, and hears narration triggered by GPS position as the vehicle passes
landmarks.

**Stack:** TypeScript, Expo bare SDK 57 (React Native 0.86), fast-check (property tests),
Jest, Fastify (backend stubs), SQLite (better-sqlite3 for Node tests,
expo-sqlite for device), MapLibre GL Native, expo-location / expo-speech /
expo-keep-awake / expo-task-manager (runtime — see "Runtime Architecture").

**Monorepo structure:** `packages/` with independent packages, each with its
own `package.json`, `tsconfig.json`, and Jest config.

> **Working with multiple tools / contributors:** the project is under git.
> Commit between handoffs; branch when working in parallel so two agents never
> write the same file at once. Do not run two Metro bundlers (`expo start`)
> against this project simultaneously (port 8081 + cache collisions).

---

## What Has Been Built

### Packages

- `packages/authoring/` — Content_Bundle JSON Schema validator + CLI (`bundle-validate`); review gate with `claims[]` verdicts, `review` block, and `--strict` mode that refuses unreviewed or refuted content
- `packages/engine/` — Pure Tour_Engine reducer (state machine, geofence pipeline, priority comparator, audio source selection, focus handling)
- `packages/storage/` — StorageManager (SQLite, atomic writes, pack downloader, LRU budget, GTFS parser/feed/policy); packLoader loads all manifest languages and exposes per-POI tone (`'standard' | 'memorial'`)
- `packages/clients/` — HTTP chokepoint, Catalog_Client, Entitlement_Client
- `packages/backend/` — Self-hosted Fastify backend with all API endpoints + Ed25519 signing
- `packages/native/` — Custom turbo modules: Location_Service, Audio_Service, TTS_Engine (iOS + Android). **NOT wired into the build — see "Runtime Architecture".**
- `packages/capability/` — OS_MATRIX, runtime probes, `useCapabilities()` hook, flag-driven command translators
- `packages/map/` — MapLibre GL Native offline tile component (`OfflineMap`); type-level support for route-polyline, POI, and user-position overlays (props declared but rendering not yet wired)
- `packages/branding/` — Brand config (display name, domains, bundle IDs)
- `packages/ui/` — Screens (route selection, tour playback) + wiring layer (TourRuntime, useTourEngine, locationAdapter)

### Simulator (`packages/simulator/src/`)

- `trace.ts` — Typed trace events (GpsFix, AppBackground/Foreground, UserCommand, fault injections)
- `generators.ts` — Deterministic trace generators (clean ride, dwell, mid-route boarding, fast pass, traffic stop, fault injection)
- `runner.ts` — Simulation runner: feeds traces through the REAL production `step()` + `reduce()` with deterministic timer/audio-completion modeling
- `readiness.ts` — Route-readiness report: per-narrative word count, timing budgets, overlap warnings, memorial analysis
- `warsaw180Config.ts` — Warsaw 180 configuration adapter (re-exports real route data for the simulator)
- `cli.ts` — CLI entry point (`npm run simulate:180`) — fires all 24 POIs, produces timing report, asserts on failures
- `simulator.test.ts` — 11 deterministic scenarios (35 assertions): clean ride, accuracy degradation, timestamp spikes, dropout, mid-route boarding, fast pass, traffic stop, focus loss/regain, lifecycle, TTS fault, second tour

### Tour_Engine (`packages/engine/src/`)

- `types.ts` — LatLng, PositionUpdate, AcceptedUpdate, Geofence (with priority + authorIndex), Entitlement, LocationMode
- `events.ts` — EngineEvent union (LocationAccepted/Rejected, Timer, EntitlementsChanged, UserCommand, AudioFinished, FocusLoss/Regain, GeofenceEnter/Dwell/Exit)
- `commands.ts` — EngineCommand union (PlaySegment, StopAudio, PauseAudio, ResumeAudio, RequestLocationMode, ScheduleTimer, CancelTimer, ShowDeviationPrompt, HideDeviationPrompt, ReleaseAll, RequestDecryptedSegment)
- `state.ts` — TourState (Idle | Active | Standby | DeadReckoning | Deviation | Ended), TourSession, PlayingSegment, BundleRef
- `reducer.ts` — Pure reducer `(state, event, now, config?) -> { state, commands[] }` implementing the full state machine, single-segment invariant, consumed-set tracking, focus loss/regain, and 2s release-on-end
- `audioSource.ts` — `selectAudioSource()`: pre-rendered audio → TTS → default-language fallback chain
- `priority.ts` — `comparePriority()` + `resolveOverlappingTriggers()` for overlapping geofences
- `pipeline/` — Geofence filtering: accuracy gate (>50m), spike rejection (>120km/h), EMA smoothing, dwell accumulator, direction filter

**Engine features intentionally deferred (not needed for current demo):**
Dead Reckoning advance/estimation, Standby_Track scheduling, Route_Deviation
classification, entitlement-aware playback filtering. The state-machine hooks
for these exist; the logic is stubbed/partial.

### Native Modules (`packages/native/`) — built, not wired in

- **iOS (Swift/ObjC):** `ios/Location/` (CLLocationManager), `ios/Audio/` (AVAudioPlayer/Session), `ios/Tts/` (AVSpeechSynthesizer)
- **Android (Kotlin):** `android/Location/` (FusedLocationProviderClient + GeofencingClient + foreground service), `android/Audio/` (ExoPlayer + AudioFocusRequest), `android/Tts/` (android.speech.tts)
- **TS specs (`src/`):** location/audio/tts facades. ⚠️ These call `TurboModuleRegistry.getEnforcing()` at import time and will crash if imported by app code until the modules are autolinked.

### Storage (`packages/storage/src/`)

- `manager.ts` — StorageManager (SQLite driver, pack paths, SHA-256 verification)
- `downloader.ts` — OfflinePackDownloader (streaming SHA verification, resume, atomic stage+rename)
- `budget.ts` — StorageBudget (2GB default, LRU eviction, active-tour protection)
- `gtfs/` — Parser, GtfsFeed lookup, atomic replacement, age policy (staleWarning/drDisabled)
- `schema.ts` — SQLite tables (pack_progress, entitlement_cache, lru_access, moderation_snapshot, device_id, license_tokens)

### Clients (`packages/clients/src/`)

- `http-client.ts` — Single chokepoint: blocks outbound during active tour (except loopback), enforces metered policy
- `catalog-client.ts` — probe(), fetchManifestLock(), fetchAsset() (with Range), refreshModeration()
- `entitlement-client.ts` — getDeviceId(), resolveEntitlements(), submitReceipt(), restorePurchases(), getCachedEntitlements()

### Backend (`packages/backend/src/`)

- `server.ts` — Fastify with all endpoints (catalog, ranged assets, GTFS, entitlements, moderation)
- `signing.ts` — Ed25519 sign/verify, canonical JSON, base64url
- `keys.ts` — Key registry (cat-001, ent-001); `store.ts` — in-memory data; `envelope.ts` — SignedEnvelope

### Map (`packages/map/src/`)

- `OfflineMap.tsx` — MapLibre GL Native component, offline-only tile source from `file://` paths
- `tileSource.ts` — Resolves `{bundleId, version}` → `file://.../tiles/{z}/{x}/{y}.pbf`
- `types.ts` — Declares `route`, `pois` (with consumed flag), and `userPosition` overlay props (typed but not yet rendered in OfflineMap.tsx)

### Capability (`packages/capability/src/`)

- `os-matrix.ts`, `probes.ts`, `dispatch.ts`, `useCapabilities.tsx`, `translators.ts`, `useTranslators.tsx`

### UI + Wiring (`packages/ui/src/`)

- `screens/RouteSelectionScreen.tsx` — lists embedded demo routes, route preview, Start Tour
- `screens/TourPlaybackScreen.tsx` — phase + route title + now-playing segment + captions + speed + End Tour
- `components/RoutePolylinePreview.tsx` — tile-free route sketch for demo routes
- `wiring/demoRoute.ts` — embedded demo geometry + metadata (Option C: no on-device pack)
- `wiring/TourRuntime.ts` — command translator (engine ↔ expo modules)
- `wiring/useTourEngine.ts` — React hook exposing `{ state, caption, playbackSpeed, startTour, endTour }`
- `wiring/locationAdapter.ts` — drives the JS geofence pipeline from expo-location fixes
- `wiring/backgroundLocationTask.ts` — TaskManager background location task
- `wiring/sampleNarratives.ts` — embedded demo narrative text (PL/EN)

---

## Runtime Architecture

**Strategy: Expo modules first.** The app ships with autolinked Expo modules for
location, speech, keep-awake, and background tasks. Custom turbo modules under
`packages/native/` remain in the repo as reference implementations and for
cherry-picked per-platform plumbing when Expo is not production-ready for a
specific requirement.

| Concern        | Module (shipping)                     | Wiring file                                              |
| -------------- | ------------------------------------- | -------------------------------------------------------- |
| Location       | `expo-location` + `expo-task-manager` | `locationAdapter.ts`, `backgroundLocationTask.ts`        |
| TTS            | `expo-speech`                         | `TourRuntime.ts`                                         |
| Audio playback | `expo-audio` (SDK 57)                 | `ExpoAudioPlaybackAdapter.ts`, `TourRuntime.ts`          |
| Keep-awake     | `expo-keep-awake`                     | `TourRuntime.ts`                                         |
| Storage        | `expo-sqlite` + `expo-file-system`    | `openDeviceStorage()`, `usePackManager`, `loadPackTour`  |
| Map (offline)  | `@maplibre/maplibre-react-native`     | `OfflineMap` on `TourPlaybackScreen` when pack installed |

### Native cherry-pick candidates (not wired unless needed)

| Gap                                      | Likely native owner               | Trigger to implement                                      |
| ---------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| LUFS normalization of pre-rendered audio | `packages/native/` Audio_Service  | Per-segment loudness matching in production audio         |
| Audio focus pause/resume with offset     | ✅ Resolved (Wave 3 — expo-audio) | —                                                         |
| OS geofence battery modes                | Location_Service                  | Background reliability still insufficient after Expo path |
| Encrypted pack decryption                | Crypto_Service                    | Req 21–22 content protection ships                        |

The custom turbo modules are **NOT autolinked** — do not import their TS
facades from app code (`TurboModuleRegistry.getEnforcing()` throws at load).

`locationAdapter.ts` feeds real GPS fixes through the **existing, tested JS
geofence pipeline** (`packages/engine/src/pipeline`). `TourRuntime` executes
engine commands against Expo modules. Narrative text comes from
`packages/ui/src/wiring/sampleNarratives.ts` (embedded for the demo; the real
path reads Markdown from a downloaded Offline_Pack via Storage_Manager).

### Known limitations of the current runtime

1. **Background location requires permission** — when the user grants background
   location, `expo-location` + `expo-task-manager` keep GPS fixes flowing via a
   foreground-service notification (Android) while pocketed. If background
   permission is denied, the tour falls back to a foreground-only watch and
   pauses when the screen locks. Cherry-pick `packages/native/` Location_Service
   only if this path is still insufficient in field testing.
2. **Map on playback** — `OfflineMap` renders when a pack-backed tour starts
   (tiles from `${docs}/packs/{bundleId}/{version}/tiles/`). Dev pack tile is a
   placeholder `.pbf`; replace with a real OSM corridor extract for cartography.
3. **Caption UI** — pack narratives load from installed Offline_Pack Markdown;
   embedded `sampleNarratives.ts` remains fallback when catalog is unreachable.
4. **Catalog required for full flow** — run `npm run backend:dev` and
   `npm run pack:build-warsaw` before device download. Embedded demo route still
   works offline without a pack.
5. **Stop-interpolated route geometry** — POI centres are real OSM stop
   platforms, but the route polyline interpolates straight lines stop-to-stop
   rather than following the road. Good enough for along-route projection and
   the preview sketch; replace with ZTM GTFS `shapes.txt` for true geometry.
   No GTFS API key is required for stop positions — Overpass is keyless.

---

## Demo Content

Demo routes live in **`packages/ui/src/wiring/demoRoute.ts`** (registry) with the
flagship route defined in **`packages/ui/src/wiring/warsaw180.ts`** (stops,
POIs, geofences) and its copy in
**`packages/ui/src/wiring/warsaw180Narratives.ts`**.

Currently one route: **Warsaw Bus 180 — northbound** — Wilanów → Żoliborz:

- 36 stops (OSM relation 15885943, stops 0–35: Wilanów → PKP Powązki), 24 authored POIs, PL + EN
- Coordinates are **real surveyed stop platforms** pulled from the public
  Overpass API (no key required) — see the provenance block at the top of
  `warsaw180.ts` for the exact query
- Catalog pack: `packages/backend/data/packs/warsaw-bus-180-north/1.0.0/` (build via `npm run pack:build-warsaw`)
- `RouteSelectionScreen`: Download Pack → Start Tour when catalog is up; embedded fallback if offline

**Northbound only.** The southbound relation (15885944) serves the opposite
kerb, which inverts every "on your left / on your right" cue, so it must ship
as a separate bundle with its own narratives. `Geofence.directionFilter` is
deliberately left unset until it is validated on a real ride — an untested
filter silently suppresses every trigger.

**The retired route.** `warsaw-tram-22-east` has been deleted (embedded route,
pack, and manifest). It described the summer-shortened tram 22, which reverted
to its normal alignment in early August 2026, so both its narration and its
terminus POI were about to become false. Bus 180 is a permanent year-round
line, which makes it safe to author against.

### Content authoring rules

Encoded as tests in `packages/ui/src/wiring/warsaw180.test.ts` (19 assertions),
because each of these was a real bug in the first draft:

1. One idea per stop, inside a spoken-duration budget — centre-city stops are
   250–400 m apart, so a long segment is still talking when the next POI fires.
2. Orientation by left/right, never compass heading.
3. No statistics as flavour, and no factual claim without a source.
4. No instructions about the app inside the narration; app affordances belong
   in the UI.
5. Memorial material (`MEMORIAL_POI_IDS`) carries `tone: 'memorial'` and is
   delivered at a reduced rate. Narrating Holocaust sites in the same wry
   register as nightlife tips is the single largest reputational risk in the
   content, so the register shift is enforced, not left to the writer.
6. No two geofences may overlap — overlapping circles make which POI fires
   depend on GPS noise.

### Factual-accuracy process

The review gate in `packages/authoring` is **load-bearing** — it exists because
the AI-drafted narration contained factual errors that would have reached
users if not caught manually. Three real errors motivated the gate:

1. **Ghetto wall misattribution.** A cemetery boundary wall was described as
   a surviving section of the Warsaw Ghetto wall. It is not.
2. **Fibreglass leaves.** An artwork's leaves were described as "originally
   natural, later replaced with fibreglass." In fact the leaves were always
   fibreglass — that is the point of the installation.
3. **Non-existent metro station.** A station was described as "under
   construction" when it has never been built. The project owner, who lives
   in Warsaw, corrected this — both Muranów and Plac Konstytucji remain
   unbuilt on the M1 line.

All three errors passed an AI confidence threshold but failed trivial
local-knowledge checks. The review gate enforces `claims[]` with a verdict
(`confirmed` / `refuted` / `unchecked`) and a source URL.
`bundle-validate --strict` refuses any bundle with an unreviewed narrative
or an `unchecked` / `unverifiable` claim. A `refuted` claim blocks the
bundle in **all** modes, not just strict.

The system trusts humans to catch the errors that models cannot distinguish
from plausible-sounding text. No bundle ships without a signed-off review.

### Storage Option A (current)

**`FileSystemPort`** abstracts disk I/O (`nodeFsPort` in tests, `expoFsPort` on
device). **`openDeviceStorage()`** opens SQLite + pack store at
`FileSystem.documentDirectory`. **`usePackManager`** lists the catalog (signature
verified against the pinned SPKI), downloads packs via **`OfflinePackDownloader`**,
and **`loadPackTour`** reads route/POIs/narratives from disk.

Dev catalog private key is gitignored (`fixtures/dev/catalog-signing-key.json`);
see `fixtures/dev/README.md`.

Dev loop:

```bash
npm run pack:build-warsaw   # writes packages/backend/data/packs/...
npm run backend:dev         # http://127.0.0.1:8080 — set CATALOG_BASE_URL to LAN IP on physical device
npx expo prebuild --clean   # after adding MapLibre native dep
```

### What happens on a real Warsaw bus right now

Board the 180 at Wilanów → Start Tour → permission prompt → GPS watch begins →
fixes run through the geofence pipeline → TTS narration fires when the smoothed
position dwells 3 s inside one of the 24 authored POI circles. Memorial
segments are spoken at a reduced rate. Between POIs the screen shows
"Active — Listening for POIs / Waiting for next POI...". With background
location permission granted, fixes continue while the screen is locked;
without it, updates pause when the app backgrounds (limitation #1 above).

---

---

## Wave 4: GPS Delivery-Stall Recovery & Field Diagnostics

### Algorithm — Delivery watchdog and bounded recovery

The `LocationAdapter` (Wave 4 extension) distinguishes **delivery** (any raw
expo-location callback reached JS) from **acceptance** (the fix passed the
pipeline's accuracy and spike gates). A delivery watchdog timer fires when no
raw callback arrives within the configurable stall threshold.

**Stall threshold justification:** Default = 15 000 ms. The engine's Dead
Reckoning phase begins at 15 s without an accepted fix. By triggering delivery
recovery at the same boundary, we attempt to restore the provider before DR
starts advancing on stale data.

**State machine:**

```
acquiring → (first callback) → live → (no callback for threshold) → recovering
recovering → (recovery complete, still no callback) → stalled
stalled → (backoff timer) → recovering → stalled → ...
any → (raw callback arrives) → live   ← resets backoff
```

**Bounded backoff:** After each failed recovery cycle (provider restarted but
no new callback), the next threshold doubles: 15 → 30 → 60 s (capped at
`maxBackoffMs`). A single successful delivery resets to base. This prevents
restart storms while keeping low-frequency recovery possible indefinitely.

**Recovery actions:**

- **Foreground channel:** remove the existing `LocationSubscription`, then
  `watchPositionAsync` again.
- **Background channel:** `stopLocationUpdatesAsync` + `startLocationUpdatesAsync`
  (idempotent). If background restart throws, demote to foreground and arm a
  foreground watch. Never tear down a working foreground watch prematurely.

**Serialization & race safety:** A tour generation counter invalidates every
async continuation after `stop()`, while a separate foreground-watch generation
invalidates callbacks retained by removed subscriptions. The `cancelled` flag
(BUG 4 invariant) is checked at every await boundary. A `recovering` flag
serializes concurrent attempts. A recovery is counted successful only after a
fresh raw callback arrives—not merely when a restart API resolves.

### Privacy contract — FieldDiagnosticsRecorder

The recorder (`packages/ui/src/wiring/fieldDiagnostics.ts`) is a pure in-memory
bounded ring + counter structure. **Structural invariants (enforced by type +
tests):**

- **NO coordinates.** The `onDelivered` event carries only bucket-input
  accuracy — never lat/lon or a provider/wall-clock timestamp. The recorder's
  API does not accept coordinate types.
- **NO route/bundle/POI IDs.** The recorder knows nothing about content.
- **NO device/account identifiers.**
- **NO free-form error messages.** All categories are fixed `LifecycleTransition`
  enums.
- **NO wall-clock timestamps.** All times are elapsed-since-start, quantized to
  500 ms buckets.
- **Accuracy is bucketed** (≤10 / ≤25 / ≤50 / >50 / unknown), never exact.

The exported JSON report includes an explicit `privacyStatement` field and a
`version: 1` tag for forward compatibility.

**Caps:** Ring limited to 200 entries (oldest evicted). Serialized report capped
at 8 192 bytes (ring truncated, then dropped entirely if still over). Status
history capped at 50.

**No automatic sharing.** The report stays in memory. `useTourEngine` exposes
`shareFieldDiagnostics()` which calls `Share.share({message})` only when the
user explicitly presses "Share diagnostics." The function catches Share
rejection without crashing.

### Field ride checklist (route 180 northbound)

Before accepting field-ride data:

1. Build: `npx expo prebuild --clean && npm run ios` (or Android)
2. Board bus 180 at Wilanów → Start Tour → grant foreground + background location
3. Lock the phone after first 3 POIs fire. Verify background delivery continues.
4. After ride: tap "Share diagnostics" → send report to yourself.
5. Verify report JSON:
   - `counters.rawDeliveries` > 0 for entire ride duration
   - `counters.recoveryAttempts` shows any stalls encountered
   - `accuracyDistribution` shows bucket profile
   - No retry interval exceeds 60 s (the provider itself may remain stalled)
   - `lifecycleRing` shows channel transitions if background was active
6. Compare `counters.geofenceFires` against the 24 authored POIs.
7. If `geofenceFires < 20`, investigate: accuracy distribution (too many >50?),
   recovery failures, or geofence radius too tight for this segment.

### Residual from actual route-180 ride

**Initial physical test ride completed.** The user tested a 3-stop segment of Warsaw Bus 180 on a physical device. Playback and runtime delivery confirmed functional in the field. Full end-to-end ride diagnostics will be logged and analyzed in subsequent field iterations.

### Simulator boundary

The simulator (`packages/simulator/`) models deterministic GPS feeds and engine
state transitions. It does **not** model:

- OS-level callback delivery interruptions (the phone silently stopping
  `watchPositionAsync` or TaskManager).
- Recovery restart sequences (these are wiring-layer concerns, not engine).
- expo-location internal retry/reconnect behavior.

The watchdog/recovery tests in `locationAdapter.recovery.test.ts` use fake
timers to validate these scenarios deterministically without a device.

---

## Suggested Next Steps (highest value first)

1. **Full-route field test bus 180 northbound end to end** — ride Wilanów → Żoliborz with
   the screen locked and log which of the 24 POIs fire. Initial 3-stop physical test ride passed; full 24-POI ride remains for final calibration.

2. **Enable `directionFilter`** on the 180 bundle — the filter is implemented
   in the geofence pipeline (Stage 5, `pipeline.ts`), but left unset on the
   authored geofences because an untested filter would silently suppress every
   trigger. Enable it only after field data shows a safe tolerance.
3. **GTFS ingest** — replace the interpolated polyline with ZTM `shapes.txt`
   and add `scheduledOffsetSec` per stop (currently `null`). The parser in
   `packages/storage/src/gtfs/` already exists.
4. **Author the southbound 180 bundle** — the southbound relation (15885944)
   serves the opposite kerb, which inverts every left/right cue. It must ship
   as a separate bundle with its own narratives.
5. **Real vector tiles** — replace the placeholder `.pbf` in the dev pack with
   an OSM corridor extract (tippecanoe / Planetiler) buffered along the 180
   alignment.
6. **Map overlays** — `OfflineMapProps` already declares `route`, `pois`, and
   `userPosition` props, but `OfflineMap.tsx` does not render them yet. Wire
   the ShapeSource/LineLayer and SymbolLayer/CircleLayer so the playback screen
   shows a GPS dot + route + POI markers.
7. **OSM attribution overlay** — a persistent overlay component on every
   MapLibre view (task 10.2); currently missing.
8. **Pre-rendered audio** — ✅ **Done (Wave 3).** The engine's `selectAudioSource()` fallback chain
   is now wired end-to-end: pack loader verifies audio files against the signed lock,
   builds a `MediaCatalog`, and the reducer dispatches `PlaySegment` with `source: 'audio'`
   and the verified `assetPath`. `TourRuntime` plays local files through an injectable
   `AudioPlaybackPort` (production: `ExpoAudioPlaybackAdapter` using expo-audio SDK 57).
   TTS remains the fallback. Render each segment with a cloud voice, normalise to ~−16 LUFS
   mono, ship as AAC/Opus in the bundle.
9. **High-accuracy indicator** — `TourPlaybackScreen` does not yet show when
   the location mode is `tour-approach` or `reconcile`.
10. **Deviation prompt UI** — engine hooks exist; classification is not yet
    wired in `reduceActive`. The 5-minute auto-end timer works.
11. **Remaining engine property tests** — P4 (priority), P9 (audio source),
    P10 (focus), P18 (capability fallback), P20 (Device_Id) are unwritten.
12. **Entitlement-aware playback filtering** — the reducer does not yet gate
    segments by entitlement tier or emit B2B disclosure pre-rolls.

---

## Key Architecture Decisions to Preserve

1. **Engine is pure** — never import native modules or do I/O in the reducer. All side effects go through commands.
2. **Single-segment invariant** — `|playing| <= 1` at all times.
3. **Consumed set is monotonic** — once a POI fires, it never replays in the same session.
4. **No network during tour** — the HTTP chokepoint throws `TourActiveBlockError` for any non-loopback URL while `isTourActive()` is true.
5. **Capability flags, not OS versions** — translators dispatch on boolean flags from `useCapabilities()`, never on `Platform.Version`.
6. **Offline-first** — map tiles, narratives, and audio are served from local storage during a tour.

---

## File Locations Quick Reference

| Concern                              | Path                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| App entry                            | `App.tsx`, `index.ts`                                                     |
| Engine reducer                       | `packages/engine/src/reducer.ts`                                          |
| Engine types                         | `packages/engine/src/{types,events,commands,state}.ts`                    |
| Geofence pipeline                    | `packages/engine/src/pipeline/`                                           |
| Audio source selection               | `packages/engine/src/audioSource.ts`                                      |
| Priority comparator                  | `packages/engine/src/priority.ts`                                         |
| UI screens                           | `packages/ui/src/screens/`                                                |
| Wiring (runtime/hook/adapter)        | `packages/ui/src/wiring/`                                                 |
| Route 180 stops/POIs/geofences       | `packages/ui/src/wiring/warsaw180.ts`                                     |
| Route 180 narratives + tone          | `packages/ui/src/wiring/warsaw180Narratives.ts`                           |
| Content authoring guards             | `packages/ui/src/wiring/warsaw180.test.ts`                                |
| Dev pack builder                     | `tooling/build-warsaw-dev-pack.mjs`                                       |
| Background location task             | `packages/ui/src/wiring/backgroundLocationTask.ts`                        |
| Custom native (not wired)            | `packages/native/`                                                        |
| Storage Manager                      | `packages/storage/src/manager.ts`                                         |
| Pack Downloader                      | `packages/storage/src/downloader.ts`                                      |
| Pack Loader (multi-lang + tone)      | `packages/storage/src/packLoader.ts`                                      |
| Budget                               | `packages/storage/src/budget.ts`                                          |
| GTFS                                 | `packages/storage/src/gtfs/`                                              |
| HTTP / Catalog / Entitlement clients | `packages/clients/src/`                                                   |
| Backend Server                       | `packages/backend/src/server.ts`                                          |
| Map Component                        | `packages/map/src/OfflineMap.tsx`                                         |
| Capability Layer                     | `packages/capability/src/`                                                |
| Branding                             | `packages/branding/src/index.ts`                                          |
| Expo Config                          | `app.config.ts`                                                           |
| Spec Documents                       | `.kiro/specs/urban-narrative-mvp/` (requirements.md, design.md, tasks.md) |

---

## Build & Run

### Tests

```bash
npm test                                  # all packages
npm test --workspace=packages/engine      # one package
```

### Type check

```bash
npx tsc --noEmit
```

### Build the Android APK (local, no EAS)

```bash
# 1. Generate native android/ project from app.config.ts
npx expo prebuild --platform android --no-install

# 2. Ensure SDK path (adjust for your OS; macOS shown)
echo "sdk.dir=$HOME/Library/Android/sdk" > android/local.properties

# 3a. Single-arch APK (~20 MB) — arm64 phones + arm64 emulators (recommended)
(cd android && ANDROID_HOME=$HOME/Library/Android/sdk \
  ./gradlew assembleRelease -x lint -PreactNativeArchitectures=arm64-v8a)

# 3b. Full multi-arch APK (~54 MB) — works on any device/emulator
(cd android && ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew assembleRelease -x lint)

# 3c. AAB for Play Store (Google delivers per-device arch, ~20–25 MB download)
(cd android && ANDROID_HOME=$HOME/Library/Android/sdk ./gradlew bundleRelease -x lint)
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

**Why the multi-arch APK is ~54 MB:** it bundles native `.so` libraries for 4
CPU architectures. `libreactnative.so` (~6 MB) and `libhermes.so` (~2 MB) are
duplicated per arch (~30 MB), plus ~15 MB of `classes*.dex`. The actual JS
bundle is only ~1.1 MB. Single-arch or AAB avoids the duplication.

### Install + launch on an emulator/device

```bash
ADB=$HOME/Library/Android/sdk/platform-tools/adb
$ADB install -r android/app/build/outputs/apk/release/app-release.apk
$ADB shell monkey -p app.tramio.client -c android.intent.category.LAUNCHER 1
```

---

## Spec / Task Tracking

The original spec lives in `.kiro/specs/urban-narrative-mvp/`
(`requirements.md`, `design.md`, `tasks.md`). As of the 2026-07-31 audit,
**45 of 87** spec tasks are checked off in `tasks.md`. The app has a
complete vertical slice: engine → wiring → UI → demo content, building and
running as an APK with 640 passing tests.
