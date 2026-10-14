# Simulator and Testing

## Simulator (`packages/simulator`)

`runSimulation(trace, config)` in `src/runner.ts` replays a GPS trace through the same `step()` and `reduce()` the app uses. It turns pipeline fires into `GeofenceDwell` events, fakes audio completion and timers, and returns a `SimulationReport`.

- Trace events (`src/trace.ts`): `GpsFix`, `AppBackground`, `AppForeground`, `UserCommand`, `TtsUnavailable`, `TtsAvailable`, `AudioInterrupted`.
- `src/generators.ts` builds synthetic traces. `src/readiness.ts` reports narrative coverage per POI.
- CLI: `npm run simulate:180` replays the Warsaw 180 route and exits non-zero on failed assertions.
- The app has a desk-replay debug mode with a speed slider (10 to 300 km/h) that feeds a recorded trace into the live runtime.

## Tests

- Jest with `ts-jest`, one project per package (`jest.config.cjs`, `jest.shared.js`).
- Property tests with `fast-check` through `tooling/property.ts` (shared run counts and a CI seed). Property suites cover the prefilter, pipeline, reducer and audio source selection.
- Type-level tests in `packages/engine/src/__tests__/types.spec-d.ts`.
- Storage tests run real SQLite through `better-sqlite3`.

```bash
npm test
```

```bash
npm run test:coverage
```
