# @tramio/authoring

Authoring_Schema definitions and the Content_Bundle validator. Also exposes the
`bundle-validate` CLI used by content authors to verify a bundle directory before
shipping it to the catalog.

Module boundary set up in task 1.3. Implementation tracked under tasks 2.1–2.5.

## CLI

```
bundle-validate [--json] [--strict] [--release] <bundle-dir>
```

Exit codes:

- **0** — bundle is valid.
- **1** — one or more validation errors.
- **2** — invalid arguments.

### Flags

| Flag         | Description                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json`     | Print `BundleValidationError[]` as JSON on stdout (for CI/editor integration).                                                                                                                                      |
| `--strict`   | Enable the review-gate: requires an approved `review` on every narrative segment; rejects claims with verdict `unchecked` or `unverifiable`.                                                                        |
| `--release`  | Enable release mode (implies `--strict`). Additionally requires `gtfsStopId` and `scheduledOffsetSec` on every stop in `route.json`. The Warsaw 180 pack cannot pass this level until GTFS shapes.txt ingest lands. |
| `-h, --help` | Show usage help.                                                                                                                                                                                                    |

### Validation levels

| Level       | What it adds over the previous level                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **default** | Schema validity, cross-file invariants, no refuted claims, confirmed claims have sourceUrl, bundle identity agreement across files |
| **strict**  | Approved review on every narrative, no unchecked/unverifiable claims                                                               |
| **release** | Every stop has `gtfsStopId` and `scheduledOffsetSec` (GTFS completeness)                                                           |

## Review gate

AI-drafted narration can ship factual errors that human review by eye does not
reliably catch. The review gate makes provenance and human sign-off structural
and machine-enforced.

Narrative frontmatter may now carry three optional fields:

- **`claims`** — array of `{ id, text, verdict, sourceUrl?, checkedAt? }` where
  verdict is `confirmed | refuted | unverifiable | unchecked`.
- **`review`** — `{ reviewedBy, reviewedAt, decision }` where decision is
  `approved | rejected | pending`.
- **`tone`** — `standard | memorial` (delivery register; `memorial` marks
  Holocaust/cemetery material).

### Validation rules

| Error code                       | Mode    | Rule                                                                  |
| -------------------------------- | ------- | --------------------------------------------------------------------- |
| `refuted-claim`                  | all     | A segment containing any claim with verdict `refuted` always fails.   |
| `confirmed-claim-missing-source` | all     | A claim marked `confirmed` must have a `sourceUrl`.                   |
| `bundle-id-mismatch`             | all     | `route.json` bundleId must match `manifest.json` bundleId.            |
| `unchecked-claim`                | strict  | A claim with verdict `unchecked` fails strict mode.                   |
| `unverifiable-claim`             | strict  | A claim with verdict `unverifiable` fails strict mode.                |
| `review-not-approved`            | strict  | A segment without `review.decision === 'approved'` fails strict mode. |
| `memorial-segment-empty`         | all     | A segment with `tone: memorial` must have a non-empty body.           |
| `release-gtfs-field-missing`     | release | A stop missing `gtfsStopId` or `scheduledOffsetSec` fails release.    |

## Content-authoring guide

For a complete walkthrough aimed at content writers — pipeline stages, frontmatter
reference, worked example, and writing rules — see **[AUTHORING.md](./AUTHORING.md)**.
