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

- `packages/authoring/` — Content_Bundle JSON Schema validator + CLI (`bundle-validate`)
- `packages/engine/` — Pure Tour_Engine reducer (state machine, geofence pipeline, priority comparator, audio source selection, focus handling)
- `packages/storage/` — StorageManager (SQLite, atomic writes, pack downloader, LRU budget, GTFS parser/feed/policy)
- `packages/clients/` — HTTP chokepoint, Catalog_Client, Entitlement_Client
- `packages/backend/` — Self-hosted Fastify backend with all API endpoints + Ed25519 signing
- `packages/native/` — Custom turbo modules: Location_Service, Audio_Service, TTS_Engine (iOS + Android). **NOT wired into the build — see "Runtime Architecture".**
- `packages/capability/` — OS_MATRIX, runtime probes, `useCapabilities()` hook, flag-driven command translators
- `packages/map/` — MapLibre GL Native offline tile component (`OfflineMap`) — built but not yet mounted
- `packages/branding/` — Brand config (display name, domains, bundle IDs)
- `packages/ui/` — Screens (route selection, tour playback) + wiring layer (TourRuntime, useTourEngine, locationAdapter)

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

| Concern       | Module (shipping)                     | Wiring file                                              |
| ------------- | ------------------------------------- | -------------------------------------------------------- |
| Location      | `expo-location` + `expo-task-manager` | `locationAdapter.ts`, `backgroundLocationTask.ts`        |
| TTS           | `expo-speech`                         | `TourRuntime.ts`                                         |
| Keep-awake    | `expo-keep-awake`                     | `TourRuntime.ts`                                         |
| Storage       | `expo-sqlite` + `expo-file-system`    | `openDeviceStorage()`, `usePackManager`, `loadPackTour`  |
| Map (offline) | `@maplibre/maplibre-react-native`     | `OfflineMap` on `TourPlaybackScreen` when pack installed |

### Native cherry-pick candidates (not wired unless needed)

| Gap                                     | Likely native owner                           | Trigger to implement                                      |
| --------------------------------------- | --------------------------------------------- | --------------------------------------------------------- |
| Pre-rendered audio + LUFS normalization | `packages/native/` Audio_Service or `expo-av` | Hero POIs with studio audio                               |
| Audio focus pause/resume with offset    | Audio_Service                                 | Phone calls interrupting narration                        |
| OS geofence battery modes               | Location_Service                              | Background reliability still insufficient after Expo path |
| Encrypted pack decryption               | Crypto_Service                                | Req 21–22 content protection ships                        |

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
5. **Placeholder coordinates** — demo POI positions are approximate; they need
   surveying against real stop/GTFS data before they'll trigger accurately.

---

## Demo Content

Demo routes live in **`packages/ui/src/wiring/demoRoute.ts`** (geometry +
metadata). Narrative copy is in **`packages/ui/src/wiring/sampleNarratives.ts`**.

Currently one route: **Warsaw Tram 22 — East (summer)** — Praga → Plac Starynkiewicza:

- POIs: PGE Narodowy, Powiśle, Plac Starynkiewicza (terminus until ~2 Aug)
- Catalog pack: `packages/backend/data/packs/warsaw-tram-22-east/1.0.0/` (build via `npm run pack:build-warsaw`)
- `RouteSelectionScreen`: Download Pack → Start Tour when catalog is up; embedded fallback if offline

Coordinates and copy are approximate demo data — replace with surveyed POI
positions and authored narratives (ideally GTFS-derived) before release.

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

### What happens on a real Warsaw tram right now

Start Tour → permission prompt → GPS watch begins → fixes run through the
geofence pipeline → TTS narration fires when the smoothed position dwells
inside one of the three Warsaw POI circles for 3s. Between POIs the screen
shows "Active — Listening for POIs / Waiting for next POI...". With background
location permission granted, fixes continue while the screen is locked; without
it, updates pause when the app backgrounds (limitation #1 above).

---

## Suggested Next Steps (highest value first)

1. **Real vector tiles** — replace the placeholder `.pbf` in the dev pack with an
   OSM corridor extract (tippecanoe / Planetiler) for Praga → Starynkiewicza.
2. **GPS dot + route overlay** on `OfflineMap` (ShapeSource line + user position).
3. **Real Warsaw content** — survey stop coordinates against GTFS; validate bundle with `bundle-validate`.
4. **Deviation prompt UI** — engine hooks exist; classification not wired in `reduceActive`.
5. **Re-enable deferred engine features** as needed (Standby, Dead Reckoning,
   entitlement gating) — reducer hooks already exist.

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
| Background location task             | `packages/ui/src/wiring/backgroundLocationTask.ts`                        |
| Custom native (not wired)            | `packages/native/`                                                        |
| Storage Manager                      | `packages/storage/src/manager.ts`                                         |
| Pack Downloader                      | `packages/storage/src/downloader.ts`                                      |
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
(`requirements.md`, `design.md`, `tasks.md`). Roughly 38 of 87 spec tasks are
checked off in `tasks.md`; several more (audio source selection, focus
handling, wiring, the two screens) are implemented but not yet re-marked. The
app currently has a complete vertical slice: engine → wiring → UI → demo
content, building and running as an APK. Tests were intentionally deferred for
the deferred engine features and UI.
