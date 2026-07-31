# Content-Authoring Guide

## Why this process exists

The first draft of the Warsaw bus 180 route shipped three factual errors that human review did not catch:

1. Narration called a wall beside the road a "Warsaw Ghetto wall". It is the wall of the Catholic Powązki cemetery. Real ghetto wall fragments survive on Sienna and Waliców.
2. Narration claimed a public artwork's palm leaves were originally natural and later replaced with plastic. Every leaf has always been fibreglass and resin on a steel core.
3. A third error survived two review passes: narration claimed a metro station's construction had begun. The station has never been built.

Prose review by eye does not catch this class of error. The validator makes fact-checking structural and machine-enforced: if a claim is not confirmed with a source URL, the bundle cannot ship.

## The six-stage pipeline

| Stage                      | Produces                                                                                                                              | Accountable   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1. Machine skeleton        | Coordinates from GTFS or OpenStreetMap. NEVER hand-typed, NEVER AI-generated.                                                         | Data engineer |
| 2. AI draft                | Narrative prose per POI, one `.md` file each. Claims marked `unchecked`.                                                              | Prompt author |
| 3. Independent fact-check  | Each claim gets a verdict (`confirmed`/`refuted`/`unverifiable`) and a `sourceUrl`. Reviewer must NOT have seen the drafting context. | Fact-checker  |
| 4. Human review & sign-off | `review` block added: `reviewedBy`, `reviewedAt`, `decision: approved`.                                                               | Content lead  |
| 5. Budget & tone check     | Word count fits the inter-stop gap (~2.6 words/sec). Memorial segments marked.                                                        | Content lead  |
| 6. Validate & sign         | Run `bundle-validate --strict`. Zero errors = shippable.                                                                              | CI / author   |

## Frontmatter fields

Every narrative `.md` file starts with YAML frontmatter between `---` fences.

### Required

| Field      | Type   | Notes                                                        |
| ---------- | ------ | ------------------------------------------------------------ |
| `poiId`    | string | Must match the POI id in `pois.json`.                        |
| `language` | string | ISO 639-1 code matching the key in `pois.json → narratives`. |

### Review gate (required for `--strict`)

| Field    | Type   | Notes                                                                                                                |
| -------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `claims` | array  | Each: `{ id, text, verdict, sourceUrl?, checkedAt? }`. Verdict: `confirmed \| refuted \| unverifiable \| unchecked`. |
| `review` | object | `{ reviewedBy, reviewedAt, decision }`. Decision: `approved \| rejected \| pending`.                                 |
| `tone`   | string | `standard` or `memorial`.                                                                                            |

**The memorial register** marks Holocaust and cemetery material. At runtime it reduces the speech rate (×0.9 multiplier) and suppresses adjacent trivia. It exists because narrating mass graves and ghettos in the same brisk voice as shopping tips reads as flippant — and is the single largest reputational risk in the content.

### Optional

| Field             | Type        | Notes                                                     |
| ----------------- | ----------- | --------------------------------------------------------- |
| `durationHintSec` | number (>0) | Expected spoken duration.                                 |
| `tier`            | string      | `free \| pro \| b2b`. Inherits from parent POI if absent. |
| `sponsor`         | string      | Required when effective tier is `b2b`.                    |
| `disclosure`      | string      | Required when effective tier is `b2b`.                    |
| `licenses`        | array       | Each: `{ id, attribution }`. Both non-empty.              |

## Error codes

| Code                                      | Fails in | Trigger                                                                     | Fix                                                       |
| ----------------------------------------- | -------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `schema-violation`                        | all      | A JSON or frontmatter field violates its schema constraint.                 | Check field types and required fields against this guide. |
| `parse-error`                             | all      | JSON or YAML syntax error.                                                  | Fix the syntax.                                           |
| `missing-file`                            | all      | A file referenced in `pois.json` or `manifest.json` does not exist on disk. | Create the file or fix the path.                          |
| `transcript-missing`                      | all      | `audio` declares a language with no matching `narratives` entry.            | Add a narrative in the same language.                     |
| `default-language-missing-from-languages` | all      | `manifest.defaultLanguage` is not in `manifest.languages`.                  | Add it to `languages`.                                    |
| `default-language-narrative-missing`      | all      | A POI has no narrative for the bundle's default language.                   | Author the missing narrative.                             |
| `b2b-disclosure-missing`                  | all      | A B2B narrative lacks `sponsor` or `disclosure`.                            | Add both fields.                                          |
| `cc-license-incomplete`                   | all      | A `licenses[]` entry has empty `id` or `attribution`.                       | Fill in both.                                             |
| `duplicate-id`                            | all      | Duplicate POI id, stop GTFS id, or standby track id.                        | Rename the duplicate.                                     |
| `standby-file-missing`                    | all      | A standby track declared in manifest has no `standby/{id}.json`.            | Create the file or remove the manifest entry.             |
| `refuted-claim`                           | all      | Any claim has `verdict: refuted`.                                           | Rewrite the narrative to remove the false assertion.      |
| `confirmed-claim-missing-source`          | all      | A `confirmed` claim has no `sourceUrl`.                                     | Add the source URL.                                       |
| `unchecked-claim`                         | strict   | A claim still has `verdict: unchecked`.                                     | Complete the fact-check.                                  |
| `unverifiable-claim`                      | strict   | A claim has `verdict: unverifiable`.                                        | Rewrite to remove or confirm it.                          |
| `review-not-approved`                     | strict   | `review.decision` is not `approved` (or review is missing).                 | Get human sign-off.                                       |
| `memorial-segment-empty`                  | all      | `tone: memorial` but the body is empty/whitespace.                          | Add content.                                              |

## Worked example

A complete narrative file that passes `--strict`:

```markdown
---
poiId: poi-palac-wilanowski
language: pl
tone: standard
claims:
  - id: wilanow-sobieski
    text: 'Pałac Wilanowski był letnią rezydencją Jana III Sobieskiego.'
    verdict: confirmed
    sourceUrl: https://www.wilanow-palac.pl/historia_palacu.html
    checkedAt: '2026-07-15T12:00:00Z'
  - id: wilanow-baroque
    text: 'Pałac jest przykładem architektury barokowej.'
    verdict: confirmed
    sourceUrl: https://en.wikipedia.org/wiki/Wilanów_Palace
    checkedAt: '2026-07-15T12:00:00Z'
review:
  reviewedBy: jan.kowalski
  reviewedAt: '2026-07-20T14:30:00Z'
  decision: approved
---

Po prawej, za parkiem — Pałac Wilanowski. Letnia rezydencja Jana III Sobieskiego, zbudowana w stylu barokowym pod koniec siedemnastego wieku. Jeden z nielicznych pałaców, które przetrwały wojnę bez zniszczeń.
```

Place this file at the path declared in `pois.json → narratives → pl` (e.g. `narratives/poi-palac-wilanowski.pl.md`).

## Running the validator

### Locally

```bash
node packages/authoring/bin/bundle-validate.js --strict path/to/bundle
```

Exit 0 = valid. Exit 1 = validation errors (printed to stderr). Exit 2 = bad arguments.

Add `--json` to get machine-readable `BundleValidationError[]` on stdout.

### In CI

```yaml
- run: node packages/authoring/bin/bundle-validate.js --strict bundles/warsaw-bus-180
```

A non-zero exit fails the pipeline. The bundle must not be deployed until exit 0.

## Writing rules

These rules come from the corrections that motivated this system:

1. **One idea per stop.** Target 12–22 spoken seconds. Stops on the Trakt Królewski are only 250–400 m apart.
2. **Left/right, not compass headings.** A passenger cannot tell north from west inside a bus.
3. **No statistics as flavour.** Budget percentages and bank rankings do not land in the ear, relate to nothing outside the window, and go stale.
4. **No instructions about the app inside narration.** "Skip back for more" belongs in the UI, not the voice.
5. **Memorial material gets its own register.** Use `tone: memorial`. Never narrate Holocaust or cemetery material in the same brisk voice as nightlife tips.
6. **Spoken-duration budget.** ~2.6 words per second against the real gap between stops. If your segment is 30 words and the gap is 8 seconds, it will not fit.
