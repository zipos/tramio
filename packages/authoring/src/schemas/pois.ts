// JSON Schema 2020-12 for `pois.json`. Mirrors `Pois` and `Poi` in `../types.ts`.

import {
  ENTITLEMENT_TIER_SCHEMA,
  POI_CATEGORIES,
  SCHEMA_BASE,
  SCHEMA_DRAFT,
  SCHEMA_VERSION,
  latLngTuple,
  languageKeyedStringMap,
} from './common';
import type { JSONSchemaType } from './kind';

export const POIS_SCHEMA_ID = `${SCHEMA_BASE}/pois/${SCHEMA_VERSION}.json`;

const geometrySchema: JSONSchemaType = {
  oneOf: [
    {
      type: 'object',
      required: ['kind', 'center', 'radiusMeters'],
      additionalProperties: false,
      properties: {
        kind: { const: 'circle' },
        center: latLngTuple(),
        radiusMeters: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    {
      type: 'object',
      required: ['kind', 'vertices'],
      additionalProperties: false,
      properties: {
        kind: { const: 'polygon' },
        vertices: {
          type: 'array',
          items: latLngTuple(),
          // Three points are the minimum for a polygon; the validator does
          // not check for self-intersection (out of MVP scope).
          minItems: 3,
        },
      },
    },
  ],
};

const directionFilterSchema: JSONSchemaType = {
  type: 'object',
  required: ['kind', 'tolerance'],
  additionalProperties: false,
  properties: {
    kind: { const: 'alongRoute' },
    tolerance: { type: 'number', exclusiveMinimum: 0, maximum: 180 },
  },
};

const deeperLayerSchema: JSONSchemaType = {
  type: 'object',
  required: ['id', 'tier', 'narrative'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    tier: ENTITLEMENT_TIER_SCHEMA,
    narrative: { type: 'string', minLength: 1 },
  },
};

// `audio` and `narratives` keys must both be ISO 639-1. The "every audio
// language has a transcript narrative in the same language" rule (Req 16.3)
// is partially expressible via JSON Schema 2020-12 alone, but the full
// cross-asset transcript-pair check (transcript file actually exists on
// disk) is enforced by the validator (task 2.2). What we DO encode here:
// `audio`'s set of property names must be a subset of `narratives`'.
//
// JSON Schema 2020-12 cannot express set-subset directly. We do the next
// best thing: require `audio` only when it is present; the validator
// (task 2.2) walks the parsed POI and checks that every key in `audio` is
// also in `narratives`. The schema layer here just guarantees both objects
// are language-keyed — which is what the schema layer can verify
// statically without reading the runtime sibling property.
const poiSchema: JSONSchemaType = {
  type: 'object',
  required: [
    'id',
    'category',
    'priority',
    'geometry',
    'dwellSec',
    'deferrable',
    'drPermitted',
    'tier',
    'narratives',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    category: { type: 'string', enum: [...POI_CATEGORIES] },
    priority: { type: 'integer', minimum: 0, maximum: 1000 },
    geometry: geometrySchema,
    directionFilter: directionFilterSchema,
    // Req 5.3: dwell of at least 3 seconds.
    dwellSec: { type: 'number', minimum: 3 },
    deferrable: { type: 'boolean' },
    drPermitted: { type: 'boolean' },
    tier: ENTITLEMENT_TIER_SCHEMA,
    narratives: languageKeyedStringMap(),
    audio: languageKeyedStringMap(),
    deeperLayers: {
      type: 'array',
      items: deeperLayerSchema,
    },
  },
};

export const poisSchema: JSONSchemaType = {
  $schema: SCHEMA_DRAFT,
  $id: POIS_SCHEMA_ID,
  title: 'Tramio Content_Bundle POIs',
  description:
    'Authored pois.json. Covers Requirements 2.3, 2.7, 5.3, 14.1. Cross-file ' +
    'invariants (every narrative reference resolves; every audio file has a ' +
    'transcript) are enforced by the validator (task 2.2).',
  type: 'object',
  required: ['pois'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string', minLength: 1 },
    pois: {
      type: 'array',
      minItems: 1,
      items: poiSchema,
    },
  },
};
