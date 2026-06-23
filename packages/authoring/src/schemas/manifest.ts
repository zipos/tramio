// JSON Schema 2020-12 for `manifest.json`. Mirrors `Manifest` in `../types.ts`.

import {
  BUNDLE_ID_PATTERN,
  ISO_3166_1_ALPHA_2_SCHEMA,
  ISO_639_1_SCHEMA,
  SCHEMA_BASE,
  SCHEMA_DRAFT,
  SCHEMA_VERSION,
  SEMVER_PATTERN,
} from './common';
import type { JSONSchemaType } from './kind';

export const MANIFEST_SCHEMA_ID = `${SCHEMA_BASE}/manifest/${SCHEMA_VERSION}.json`;

export const manifestSchema: JSONSchemaType = {
  $schema: SCHEMA_DRAFT,
  $id: MANIFEST_SCHEMA_ID,
  title: 'Tramio Content_Bundle manifest',
  description:
    'Authored manifest.json for a Content_Bundle. Covers Requirements 2.2, 2.7, 14.1, 17.2.',
  type: 'object',
  required: [
    'bundleId',
    'version',
    'city',
    'transitLine',
    'languages',
    'defaultLanguage',
    'minAppVersion',
    'deadReckoning',
    'standbyTracks',
    'attribution',
    'checksumAlgorithm',
  ],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string', minLength: 1 },
    bundleId: { type: 'string', pattern: BUNDLE_ID_PATTERN },
    version: { type: 'string', pattern: SEMVER_PATTERN },
    city: {
      type: 'object',
      required: ['id', 'country'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        country: ISO_3166_1_ALPHA_2_SCHEMA,
      },
    },
    transitLine: {
      type: 'object',
      required: ['gtfsRouteId', 'direction', 'agency'],
      additionalProperties: false,
      properties: {
        gtfsRouteId: { type: 'string', minLength: 1 },
        direction: { type: 'string', minLength: 1 },
        agency: { type: 'string', minLength: 1 },
      },
    },
    languages: {
      type: 'array',
      items: ISO_639_1_SCHEMA,
      minItems: 1,
      uniqueItems: true,
    },
    defaultLanguage: ISO_639_1_SCHEMA,
    minAppVersion: { type: 'string', pattern: SEMVER_PATTERN },
    deadReckoning: {
      type: 'object',
      required: ['permitted', 'maxLeadSeconds'],
      additionalProperties: false,
      properties: {
        permitted: { type: 'boolean' },
        maxLeadSeconds: { type: 'integer', minimum: 0 },
      },
    },
    standbyTracks: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      uniqueItems: true,
    },
    attribution: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['kind'],
            additionalProperties: false,
            properties: {
              kind: { const: 'osm' },
            },
          },
          {
            // Creative Commons attribution requires both `license` (id) and a
            // non-empty `attribution` string — Requirement 17.2.
            type: 'object',
            required: ['kind', 'license', 'attribution'],
            additionalProperties: false,
            properties: {
              kind: { const: 'cc' },
              license: { type: 'string', minLength: 1 },
              attribution: { type: 'string', minLength: 1 },
            },
          },
        ],
      },
    },
    checksumAlgorithm: { const: 'sha256' },
  },
};
