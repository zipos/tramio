# Field ride backlog (Warsaw Bus 180)

Captured from the first physical ride notes (embassy corridor / Plac na Rozdrożu) and the 2026-08-02 product synthesis. This file is the durable parking lot so later work is not lost when context is spent on the current focus.

## Current focus (do now)

1. **Location battery optimization** — cruise vs approach sampling; honour `RequestLocationMode`; keep-awake only while foregrounded. (done; iOS auto-pause off)
2. **Poco-first desk testing** — `__DEV__` Desk replay + **Next POI** / trip-speed controls on playback. Share diagnostics stays in release. Voice speed collapsed under Narration settings.

## Recently fixed from desk ride

- False **“GPS data arriving but accuracy poor”** banner was wired to “no recent _accepted_ fix,” not real accuracy rejects — hung UI near Trzech Krzyży often meant rejects or stale lastAccepted (distance frozen). Banner now uses reject streak.
- Desk replay default length extended through Trzech Krzyży (8 POIs).

## Deferred — preserve entirely

### Voice / TTS quality

- Shipping voice is OS `expo-speech` (AVSpeech / Android TTS), **not** on-device foundation models.
- Dry robotic English; Polish names sound like gibberish on English TTS.
- Pre-rendered pack audio path already exists (`selectAudioSource` → `ExpoAudioPlaybackAdapter`); bake cloud voices into packs at authoring time (offline-first — do **not** stream TTS during rides).
- ElevenLabs ballpark (2026): Multilingual ≈ $0.10/1k chars, Flash/Turbo ≈ $0.05/1k; Creator ~$22/mo, Pro ~$99/mo. Full EN+PL 180 re-render is a few dollars if baked infrequently.
- Near-term: voice bake-off (3–5 voices × hard Polish name samples) → pick default → LUFS-normalise (~−16) AAC/Opus into pack.
- Add pronunciation glossary / phonetic rewrites for Polish toponyms when using EN narration.

### Trigger model / content density

- Engine is geofence POIs, not stop-only — but Aleje Ujazdowskie felt like ~400 m of embassy silence between stop-tied cues.
- Author **corridor POIs** with look-ahead (trigger slightly before landmark enters view; budget from speed × speak duration — see `packages/authoring/AUTHORING.md`).
- Stops = interchange / alight activity; mid-block architecture = first-class POIs.
- GTFS `shapes.txt` + `scheduledOffsetSec` still TODO (`packages/storage/src/gtfs/` parser exists). GTFS helps dead-reckoning / desync, not as the sole “interesting building” trigger.
- Enable `directionFilter` on 180 only after field/sim data shows safe tolerance.
- Author southbound 180 as separate bundle (opposite kerb flips L/R cues).

### Map / UI

- Map **is already in the plan**: MapLibre offline (`packages/map`), task 10.1 done; 10.2–10.3 attribution open.
- HANDOFF: real corridor `.pbf` tiles; render typed but unused `route` / `pois` / `userPosition` overlays; OSM attribution.
- Playback UI still thin (captions, speed, next-POI chip, banners). Make active ride map-first and glanceable.
- Deeper topic drill-down: prefer offline second narrative layer / existing `token_unlock` tier before live LLM chat mid-tour (conflicts with offline + heat + cost). Wi‑Fi “explore later” LLM is fine later.
- Live Activities: capability flag only; implement after playback UI is informative; Android → rich notification fallback.

### Heat / battery / storage (beyond current location work)

- Diagnose **database error after closing app** — user mentioned a screenshot; still needed. Suspects: SQLite open/close, pack integrity, `documentDirectory`, background task teardown.
- After adaptive location lands: profile remaining drain (map render while backgrounded, FGS notification, keep-awake policy).

### Naming / modality

- Spec already = buses + trams; shipped content = bus 180; name “Tramio” is the brand constraint.
- Rename via `packages/branding` when shortlist ready: transit-spirited, mode-agnostic (lines / rides / city past the window), not rails-only.
- Engine is GPS-agnostic — Uber/car corridor packs are a later catalog framing, not the lead story. Lead with public transit.

### Interests / verbosity / onboarding

- Schema categories today: `landmark` | `architectural-detail` | `trivia`. No onboarding.
- Extend interest tags (e.g. history, politics/embassies, infrastructure) + density knob (`sparse` / `standard` / `dense`) filtered at tour start.
- Onboarding = one anonymous screen (Device_Id model); no account required.

### Quality POI generation at city scale

- Six-stage authoring + fact-check gate exists because early AI drafts shipped factual errors (ghetto wall, palm leaves, unbuilt metro).
- Free 24/7 Hermes / NVIDIA NIM agents: **Stage 2 draft only** (`verdict: unchecked`). Stages 3–4 independent fact-check + human `approved` remain the ship gate (`bundle-validate --strict`).
- First unknown-city dogfood after Warsaw feels right: London or Stockholm.

### Already in engineering HANDOFF (keep aligned)

See [HANDOFF.md](../HANDOFF.md) “Suggested Next Steps”: full-route field calibration, directionFilter, GTFS ingest, southbound bundle, tiles, map overlays, attribution, pre-rendered audio bake, high-accuracy indicator UI, deviation prompt UI, remaining property tests, entitlement-aware filtering.

## Sequencing reminder (after current focus)

1. Voice bake-off + pre-render hero 180 segments
2. Map overlays + real tiles
3. Corridor POI pass (embassy stretch) → then GTFS shapes
4. DB-on-close fix from screenshot
5. Interest tags + density + onboarding
6. Rename when shortlist ready
7. Draft agent behind fact-check gate → London/Stockholm
8. Live Activities
9. LLM drill-down / car corridor mode

## Source notes (essence)

> Audio dry/robotic; PL names gibberish — need alternative voices / ElevenLabs pricing.  
> 400 m embassy road silence → stop-triggered audio only makes sense for interchanges; interesting mid-route things should fire just before they happen; mind GTFS delay.  
> UI must be useful: free map + deeper LLM drill-down later; Live Activities on both platforms.  
> Device heats, drains battery; DB error after close (screenshot).  
> “Tramio” too tram-narrow — buses dominate interesting routes; narration should work in a car too; rename keeping public-transit spirit.  
> Verbosity/POI density tweakable via interests (history, politics, infrastructure) as onboarding.  
> Quality POI pipeline now — Hermes on free models 24/7 as draft strategy; build cities without knowing them; first unknown city London or Stockholm.
