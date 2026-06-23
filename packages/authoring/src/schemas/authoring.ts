// Top-level Authoring_Schema descriptor. Enumerates every per-file schema
// the validator and bundle-validate CLI need to know about, keyed by the
// file kind defined in design.md (`## Data Models > Authoring_Schema`).
//
// This is intentionally a TypeScript object rather than another JSON Schema
// document: it is the registry the validator (task 2.2) consults to pick
// which schema applies to a given file path. Each entry carries:
//
//   - `kind`         — discriminator used in error reporting.
//   - `schemaId`     — versioned `$id` URI (`https://schema.tramio.app/...`).
//   - `schema`       — the parsed JSON Schema 2020-12 document.
//   - `pathPattern`  — regex that matches files of this kind inside a bundle
//                      directory (relative to the bundle root).

import { manifestSchema, MANIFEST_SCHEMA_ID } from './manifest';
import {
  narrativeFrontmatterSchema,
  NARRATIVE_FRONTMATTER_SCHEMA_ID,
} from './narrativeFrontmatter';
import { poisSchema, POIS_SCHEMA_ID } from './pois';
import { routeSchema, ROUTE_SCHEMA_ID } from './route';
import { standbyTrackSchema, STANDBY_TRACK_SCHEMA_ID } from './standbyTrack';
import { SCHEMA_BASE, SCHEMA_VERSION } from './common';
import type { JSONSchemaType } from './kind';

/** Discriminator for the kind of authoring file a given schema applies to. */
export type AuthoringFileKind =
  | 'manifest'
  | 'route'
  | 'pois'
  | 'narrative-frontmatter'
  | 'standby-track';

export interface AuthoringSchemaEntry {
  readonly kind: AuthoringFileKind;
  readonly schemaId: string;
  readonly schema: JSONSchemaType;
  /** Regex matching the file path (relative to the bundle root). */
  readonly pathPattern: RegExp;
}

export const AUTHORING_SCHEMA_BASE = SCHEMA_BASE;
export const AUTHORING_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * Registry of every JSON Schema 2020-12 document owned by the
 * Authoring_Schema. Frozen so downstream code (validator, CLI) cannot
 * mutate it accidentally.
 */
export const AUTHORING_SCHEMAS: Readonly<Record<AuthoringFileKind, AuthoringSchemaEntry>> =
  Object.freeze({
    manifest: {
      kind: 'manifest',
      schemaId: MANIFEST_SCHEMA_ID,
      schema: manifestSchema,
      pathPattern: /^manifest\.json$/,
    },
    route: {
      kind: 'route',
      schemaId: ROUTE_SCHEMA_ID,
      schema: routeSchema,
      pathPattern: /^route\.json$/,
    },
    pois: {
      kind: 'pois',
      schemaId: POIS_SCHEMA_ID,
      schema: poisSchema,
      pathPattern: /^pois\.json$/,
    },
    'narrative-frontmatter': {
      kind: 'narrative-frontmatter',
      schemaId: NARRATIVE_FRONTMATTER_SCHEMA_ID,
      schema: narrativeFrontmatterSchema,
      // narratives/{poiId}.{lang}.md
      pathPattern: /^narratives\/[A-Za-z0-9_.-]+\.[a-z]{2}\.md$/,
    },
    'standby-track': {
      kind: 'standby-track',
      schemaId: STANDBY_TRACK_SCHEMA_ID,
      schema: standbyTrackSchema,
      // standby/{trackId}.json (the per-language markdown/audio files in
      // standby/ are NOT this kind; they share the narrative-frontmatter
      // schema for their frontmatter blocks).
      pathPattern: /^standby\/[A-Za-z0-9_.-]+\.json$/,
    },
  });

/**
 * Convenience: lookup the schema entry for a given bundle-relative path.
 * Returns `undefined` when no schema applies (e.g. a `.pbf` tile, an `.m4a`
 * audio asset, or any path the bundle layout does not enumerate).
 */
export function findSchemaForPath(relativePath: string): AuthoringSchemaEntry | undefined {
  for (const entry of Object.values(AUTHORING_SCHEMAS)) {
    if (entry.pathPattern.test(relativePath)) return entry;
  }
  return undefined;
}
