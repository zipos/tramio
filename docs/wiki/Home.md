# Tramio Architecture Wiki

Tramio turns an ordinary city bus or tram into a guided tour. The rider starts a tour, the phone tracks GPS, and narration plays as the vehicle passes landmarks. Everything needed for the ride (map tiles, narration, audio) is downloaded beforehand as a signed offline pack.

## Pages

| Page                                              | What it covers                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| [System Overview](System-Overview.md)             | The big picture: packages, data flow, runtime vs content time               |
| [Tour Engine](Tour-Engine.md)                     | The pure reducer, the GPS pipeline, priority, focus, audio source selection |
| [App Runtime](App-Runtime.md)                     | How the Expo app wires GPS, audio, TTS, map and engine together             |
| [Content Packs](Content-Packs.md)                 | Pack layout, authoring, validation levels, signing and verification         |
| [Backend and Clients](Backend-and-Clients.md)     | Fastify catalog/entitlement API, HTTP clients, storage, SQLite              |
| [Simulator and Testing](Simulator-and-Testing.md) | Deterministic ride replay, property tests                                   |
| [Status and Known Gaps](Status-and-Known-Gaps.md) | What is wired, what is stubbed, what is dead code                           |

## One-paragraph summary

A **pure TypeScript reducer** (`packages/engine`) takes events (GPS fix accepted, dwell reached, audio finished, focus lost) and returns commands (play segment, stop, change location mode). The **app shell** (`packages/ui`) runs that reducer against real Expo modules: `expo-location` for GPS, `expo-audio` for pre-rendered narration, `expo-speech` as TTS fallback, and MapLibre for an offline map. Content is authored as **route bundles**, validated by `packages/authoring`, hashed into a `MANIFEST.lock.json`, signed with Ed25519, and verified on device by `packages/storage` before anything plays. A small **Fastify backend** (`packages/backend`) serves the catalog, assets and entitlement stubs.

## Conventions used in this wiki

- Paths are relative to the repository root.
- "Wired" means the code runs in the shipping app. "Built" means it exists and is tested, but nothing in the app calls it.
