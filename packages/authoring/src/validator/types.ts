// Public types for the Content_Bundle validator (task 2.2).
//
// Validation produces a discriminated result: either a fully `LoadedBundle`
// (every authored file parsed, schema-valid, cross-file invariants
// satisfied) or a list of `BundleValidationError`s, each pinned to a single
// `filePath` + RFC 6901 `jsonPointer` location.

import type {
  Manifest,
  NarrativeFrontmatter,
  Pois,
  Route,
  StandbyTrack,
} from '../types';

/**
 * Closed taxonomy of hint codes attached to validation errors. The codes
 * are stable identifiers so downstream tooling (CLI output formatters,
 * authoring harness UIs) can switch on them; the human `text` is meant
 * for direct display to a content author.
 */
export type HintCode =
  | 'schema-violation'
  | 'parse-error'
  | 'missing-file'
  | 'transcript-missing'
  | 'default-language-missing-from-languages'
  | 'default-language-narrative-missing'
  | 'b2b-disclosure-missing'
  | 'cc-license-incomplete'
  | 'duplicate-id'
  | 'standby-file-missing';

export interface Hint {
  readonly code: HintCode;
  readonly text: string;
}

/**
 * A single validation error. `filePath` is the bundle-relative path of
 * the offending file (e.g. `pois.json`, `narratives/poi-rynek.pl.md`).
 * `jsonPointer` is an RFC 6901 pointer into that file's parsed
 * representation; for narrative Markdown the pointer addresses the
 * frontmatter object (e.g. `/sponsor` or `/licenses/0/attribution`).
 */
export interface BundleValidationError {
  readonly filePath: string;
  readonly jsonPointer: string;
  readonly message: string;
  readonly hint: Hint;
}

export interface LoadedNarrative {
  /** Bundle-relative path to the source `.md` file. */
  readonly filePath: string;
  readonly frontmatter: NarrativeFrontmatter;
  readonly body: string;
}

export interface LoadedBundle {
  readonly manifest: Manifest;
  readonly route: Route;
  readonly pois: Pois;
  /** Keyed by bundle-relative narrative path. */
  readonly narratives: ReadonlyMap<string, LoadedNarrative>;
  /** Keyed by standby track id. */
  readonly standbyTracks: ReadonlyMap<string, StandbyTrack>;
  /** Bundle-relative paths of every audio asset confirmed on disk. */
  readonly audioFiles: ReadonlySet<string>;
}

export type ValidationResult =
  | { readonly ok: true; readonly bundle: LoadedBundle }
  | { readonly ok: false; readonly errors: readonly BundleValidationError[] };
