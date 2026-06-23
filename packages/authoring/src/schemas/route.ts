// JSON Schema 2020-12 for `route.json`. Mirrors `Route` in `../types.ts`.

import {
  BUNDLE_ID_PATTERN,
  SCHEMA_BASE,
  SCHEMA_DRAFT,
  SCHEMA_VERSION,
  latLngTuple,
} from './common';
import type { JSONSchemaType } from './kind';

export const ROUTE_SCHEMA_ID = `${SCHEMA_BASE}/route/${SCHEMA_VERSION}.json`;

export const routeSchema: JSONSchemaType = {
  $schema: SCHEMA_DRAFT,
  $id: ROUTE_SCHEMA_ID,
  title: 'Tramio Content_Bundle route',
  description: 'Authored route.json. Covers Requirement 2.2 and 8.1 (deviation corridor).',
  type: 'object',
  required: ['bundleId', 'polyline', 'stops', 'deviationCorridorMeters'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string', minLength: 1 },
    bundleId: { type: 'string', pattern: BUNDLE_ID_PATTERN },
    polyline: {
      type: 'array',
      items: latLngTuple(),
      minItems: 2,
    },
    stops: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['id', 'gtfsStopId', 'coord', 'scheduledOffsetSec'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          gtfsStopId: { type: 'string', minLength: 1 },
          coord: latLngTuple(),
          scheduledOffsetSec: { type: 'integer', minimum: 0 },
        },
      },
    },
    deviationCorridorMeters: { type: 'number', exclusiveMinimum: 0 },
  },
};
