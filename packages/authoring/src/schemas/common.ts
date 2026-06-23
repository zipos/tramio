// Shared sub-schemas used by manifest.json, route.json, pois.json,
// narrative-markdown-frontmatter, and standby-track.json. Centralized here so
// the entitlement tier enum, the ISO 639-1 pattern, and the lat/lng tuple
// definition stay in lockstep across every schema.

import type { JSONSchemaType } from './kind';

/** Versioned base URI for `$id` and `$ref` resolution. */
export const SCHEMA_BASE = 'https://schema.tramio.app';
export const SCHEMA_VERSION = '1';
export const SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

export const ENTITLEMENT_TIERS = ['free', 'time_pass', 'token_unlock', 'b2b'] as const;

export const POI_CATEGORIES = ['landmark', 'architectural-detail', 'trivia'] as const;

export const STANDBY_CATEGORIES = ['trivia', 'ambient'] as const;

/** ISO 639-1 pattern: exactly two lowercase letters. */
export const ISO_639_1_PATTERN = '^[a-z]{2}$';

/** ISO 3166-1 alpha-2 pattern: exactly two uppercase letters. */
export const ISO_3166_1_ALPHA_2_PATTERN = '^[A-Z]{2}$';

/** Permissive semver pattern. */
export const SEMVER_PATTERN =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
  '(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?' +
  '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$';

/** Bundle ids must be lowercase kebab/dot/underscore-friendly. */
export const BUNDLE_ID_PATTERN = '^[a-z0-9](?:[a-z0-9_.-]{0,127})$';

/** Language-keyed object: keys must be ISO 639-1 codes; values are bundle-relative paths. */
export function languageKeyedStringMap(): JSONSchemaType {
  return {
    type: 'object',
    propertyNames: { pattern: ISO_639_1_PATTERN },
    patternProperties: {
      [ISO_639_1_PATTERN]: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
    minProperties: 1,
  };
}

/**
 * Tuple schema for `[lat, lng]`. JSON Schema 2020-12 expresses tuples as
 * `prefixItems` + `items: false`.
 */
export function latLngTuple(): JSONSchemaType {
  return {
    type: 'array',
    prefixItems: [
      { type: 'number', minimum: -90, maximum: 90 },
      { type: 'number', minimum: -180, maximum: 180 },
    ],
    items: false,
    minItems: 2,
    maxItems: 2,
  };
}

export const ENTITLEMENT_TIER_SCHEMA: JSONSchemaType = {
  type: 'string',
  enum: [...ENTITLEMENT_TIERS],
};

export const ISO_639_1_SCHEMA: JSONSchemaType = {
  type: 'string',
  pattern: ISO_639_1_PATTERN,
};

export const ISO_3166_1_ALPHA_2_SCHEMA: JSONSchemaType = {
  type: 'string',
  pattern: ISO_3166_1_ALPHA_2_PATTERN,
};
