# Tramio

**GPS-triggered audio tours on ordinary buses and trams.**

You board a real city route, start a tour, and narration fires as you pass landmarks — offline tiles, signed content packs, and a pure TypeScript tour engine deciding what plays next.

> Spec-driven portfolio MVP (Expo bare / React Native). Strong copyleft: **[AGPL-3.0-or-later](LICENSE)** — not for closed-source products. Engineering depth lives in [HANDOFF.md](HANDOFF.md).

## Why this is interesting

Most “tour apps” are map pins plus a media player. Tramio is a **ride-time control system**:

- **Pure Tour Engine** — geofence pipeline, priority, dwell, focus loss/regain, and audio commands as a testable reducer (no React Native in the core).
- **Offline-first** — MapLibre GL Native with local vector tiles; no Google Maps / Mapbox commercial tile dependency for the tour map.
- **Signed content** — route bundles verified with Ed25519 before load; authoring validator with review gates and `--strict` fact-check rules.
- **Deterministic simulation** — replayable GPS traces through the real `step()` / `reduce()` path (`npm run simulate:180`).
- **Monorepo boundaries** — engine, storage, clients, map, UI, backend, and authoring are separate packages with clear ownership.

## How it fits together

```text
  Signed Content Packs          Catalog / Entitlement API (Fastify)
           │                              │
           ▼                              ▼
     Storage Manager  ◄──────────  HTTP clients (signature verify)
     (SQLite, packs, LRU)
           │
           ▼
  GPS · timers · focus · audio done
           │
           ▼
     ┌─────────────────┐
     │   Tour Engine   │  pure reducer → commands
     └────────┬────────┘
              │
              ▼
     UI · TTS / audio · OfflineMap (MapLibre)
```

**Content** is authored as route bundles (`manifest`, route geometry, POIs, narratives, optional audio/tiles), validated, signed, and installed as offline packs. **Runtime** feeds location and lifecycle events into the engine; the engine emits play/stop/location-mode commands. **Native turbo modules** for location/audio/TTS exist under `packages/native/` but are not the default wired path yet — the Expo modules + UI wiring layer drive the current demo.

## Repo topology

Root = Expo bare app (`App.tsx`, `app.config.ts`). `ios/` and `android/` are **generated** by `expo prebuild` (not committed).

| Package                   | Role                                                                         |
| ------------------------- | ---------------------------------------------------------------------------- |
| `packages/engine`         | Pure tour state machine, geofence pipeline, priority, audio source selection |
| `packages/storage`        | Pack download, integrity, SQLite, GTFS helpers, LRU budget                   |
| `packages/clients`        | Catalog + entitlement HTTP clients, public-key pin                           |
| `packages/crypto-service` | Ed25519 helpers for catalog verification                                     |
| `packages/backend`        | Self-hosted Fastify catalog / entitlement / moderation stubs                 |
| `packages/authoring`      | Content_Bundle schema validator + `bundle-validate` CLI                      |
| `packages/map`            | Offline MapLibre map (`OfflineMap`)                                          |
| `packages/ui`             | Screens + tour runtime wiring                                                |
| `packages/capability`     | OS capability matrix, probes, translators                                    |
| `packages/native`         | Custom turbo modules (Location / Audio / TTS) — built, not default-linked    |
| `packages/simulator`      | Deterministic ride simulator + readiness reports                             |
| `packages/branding`       | Display name, scheme, bundle IDs                                             |

Specs and design notes: [`.kiro/specs/urban-narrative-mvp/`](.kiro/specs/urban-narrative-mvp/). Day-to-day engineering context: [HANDOFF.md](HANDOFF.md).

## Status (honest)

Working demo path: select a route, run a tour with GPS (or desk replay), hear TTS/narration as geofences fire, show offline map shell.

Intentionally incomplete or deferred vs a store product: some engine modes (dead reckoning / deviation / standby scheduling) are stubbed; map route/POI/user overlays are typed but not fully rendered; custom turbo modules are not the live path; content packs need human review for `--strict` release.

## Quick start

```sh
npm install
npx expo prebuild              # generate ios/ + android/
npm run ios                    # or: npm run android
```

**Needs:** Node 20+, Expo SDK 57 (RN 0.86), Xcode / Android Studio as usual for device builds.

Useful:

```sh
npm test
npm run simulate:180
npm run validate:packs
npm run backend:dev
```

Content authoring, permissions, and EAS profiles: see [HANDOFF.md](HANDOFF.md) and [`packages/authoring/AUTHORING.md`](packages/authoring/AUTHORING.md).

## License

**GNU Affero General Public License v3.0 or later** — [LICENSE](LICENSE), [NOTICE](NOTICE).

**Plain language:**

- You may use, study, modify, and redistribute this code under AGPL.
- If you **distribute** a binary or fork, or run a **modified network service** users interact with, you must make the corresponding source available under AGPL-compatible terms.
- **Proprietary / closed-source products cannot incorporate this codebase** without a separate license from the copyright holder.
- Private local experimentation without redistribution is generally fine; read the full license for your case.

This is **not** MIT/Apache. Not legal advice. For commercial closed-source licensing, contact the copyright holder.
