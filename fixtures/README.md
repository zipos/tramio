# fixtures/

Shared test fixtures consumed by property and unit tests across the workspace.

Expected contents (populated as tasks land):

- `bundles/valid/` — known-good Content_Bundles used by `@tramio/authoring`
  property and unit tests (tasks 2.4, 2.5) and by the end-to-end integration
  test (task 14.3).
- `bundles/invalid/` — one fixture per discriminated `BundleValidationError`
  class (missing transcript, missing disclosure, missing CC license,
  out-of-range value, etc.). Used by the validator unit tests (task 2.5).
- `traces/` — deterministic CSV location traces replayed through the geofence
  pipeline + engine in trace-replay integration tests (task 13.4): clean ride,
  tunnel (90 s signal loss), traffic stop (2 min zero motion), deviation,
  spike storm, overlapping geofences with varied priorities.
- `gtfs/` — small GTFS feeds with controlled timestamps for the GTFS-age
  policy property test (task 7.3).

This directory is intentionally checked in so tests are reproducible without
network access.
