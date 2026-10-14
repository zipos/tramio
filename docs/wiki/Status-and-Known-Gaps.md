# Status and Known Gaps

As of October 2026.

## Works end to end

- Pick the Warsaw 180 route, start a tour, ride with real GPS or desk replay.
- Narration plays from pre-rendered audio, or TTS when audio is missing.
- Offline map with route, POI states and rider position.
- Pack signature and hash verification before load.
- A 3-stop physical field ride passed. The full northbound ride is pending.

## Built but not wired

| Item                                      | Where                            | Note                                                       |
| ----------------------------------------- | -------------------------------- | ---------------------------------------------------------- |
| Custom turbo modules                      | `packages/native`                | Not autolinked. Expo modules are used instead              |
| Capability layer                          | `packages/capability`            | Imported only by its own tests                             |
| Standby, Deviation, Dead Reckoning states | `packages/engine/src/reducer.ts` | No production event enters them                            |
| `DeviationSheet`                          | `packages/ui`                    | Nothing emits `ShowDeviationPrompt`                        |
| Entitlement-gated playback                | clients, backend, storage        | Receipt verification for Apple/Google is not implemented   |
| Crypto service                            | `packages/crypto-service`        | Empty module. Only Ed25519 verification exists, in storage |

## Known field issues

From `docs/field-ride-backlog.md`:

- Device heat and battery drain on long rides.
- English TTS mispronounces Polish names.
- About 400 m of the route has no POIs ("embassy silence").
- Direction filter is off. Southbound needs its own bundle.
- GTFS `shapes.txt` and stop offsets are not ingested, so route geometry is stop-to-stop lines and `--release` validation cannot pass.
- An unexplained database error after closing the app.
