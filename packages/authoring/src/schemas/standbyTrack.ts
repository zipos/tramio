// JSON Schema 2020-12 for `standby/{trackId}.json`. Mirrors `StandbyTrack`
// in `../types.ts`. Standby tracks are language-keyed, may carry pre-rendered
// audio, and are tier-gated like POIs.

import {
  ENTITLEMENT_TIER_SCHEMA,
  ISO_639_1_SCHEMA,
  SCHEMA_BASE,
  SCHEMA_DRAFT,
  SCHEMA_VERSION,
  STANDBY_CATEGORIES,
  languageKeyedStringMap,
} from './common';
import type { JSONSchemaType } from './kind';

export const STANDBY_TRACK_SCHEMA_ID = `${SCHEMA_BASE}/standby-track/${SCHEMA_VERSION}.json`;

export const standbyTrackSchema: JSONSchemaType = {
  $schema: SCHEMA_DRAFT,
  $id: STANDBY_TRACK_SCHEMA_ID,
  title: 'Tramio Content_Bundle standby track',
  description:
    'Authored standby/{trackId}.json. Covers Requirements 7.1, 14.1, and the ' +
    'transcript-pair half of Requirement 16.3 expressible in pure JSON Schema. ' +
    'Cross-file checks (audio-language ⊆ narrative-language, files exist on ' +
    'disk) are enforced by the validator (task 2.2).',
  type: 'object',
  required: ['id', 'category', 'languages', 'narratives', 'tier'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string', minLength: 1 },
    id: { type: 'string', minLength: 1 },
    category: { type: 'string', enum: [...STANDBY_CATEGORIES] },
    languages: {
      type: 'array',
      items: ISO_639_1_SCHEMA,
      minItems: 1,
      uniqueItems: true,
    },
    narratives: languageKeyedStringMap(),
    audio: languageKeyedStringMap(),
    tier: ENTITLEMENT_TIER_SCHEMA,
    loop: { type: 'boolean' },
    durationHintSec: { type: 'number', exclusiveMinimum: 0 },
  },
};
