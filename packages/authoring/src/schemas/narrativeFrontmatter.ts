// JSON Schema 2020-12 for the YAML frontmatter parsed out of a narrative
// Markdown file. Mirrors `NarrativeFrontmatter` in `../types.ts`. This schema
// validates the *parsed* frontmatter object; turning the raw `---` YAML block
// into JSON happens in the validator (task 2.2).

import {
  ENTITLEMENT_TIER_SCHEMA,
  ISO_639_1_SCHEMA,
  SCHEMA_BASE,
  SCHEMA_DRAFT,
  SCHEMA_VERSION,
} from './common';
import type { JSONSchemaType } from './kind';

export const NARRATIVE_FRONTMATTER_SCHEMA_ID = `${SCHEMA_BASE}/narrative-frontmatter/${SCHEMA_VERSION}.json`;

const licenseSchema: JSONSchemaType = {
  // CC license entry: id and attribution both required and non-empty
  // (Requirement 17.2).
  type: 'object',
  required: ['id', 'attribution'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    attribution: { type: 'string', minLength: 1 },
  },
};

export const narrativeFrontmatterSchema: JSONSchemaType = {
  $schema: SCHEMA_DRAFT,
  $id: NARRATIVE_FRONTMATTER_SCHEMA_ID,
  title: 'Tramio narrative Markdown frontmatter',
  description:
    'YAML frontmatter parsed out of `narratives/{poiId}.{lang}.md`. Covers ' +
    'Requirements 14.5 (B2B sponsor + disclosure), 17.2 (CC license + ' +
    'attribution), 20.4 (B2B with no disclosure is rejected).',
  type: 'object',
  required: ['poiId', 'language'],
  additionalProperties: false,
  properties: {
    poiId: { type: 'string', minLength: 1 },
    language: ISO_639_1_SCHEMA,
    durationHintSec: { type: 'number', exclusiveMinimum: 0 },
    sponsor: {
      // String OR null OR absent for non-sponsored content.
      type: ['string', 'null'],
      minLength: 1,
    },
    disclosure: {
      type: ['string', 'null'],
      minLength: 1,
    },
    tier: ENTITLEMENT_TIER_SCHEMA,
    licenses: {
      type: 'array',
      items: licenseSchema,
    },
  },
  // Requirements 14.5 + 20.4: when the narrative declares `tier: b2b`,
  // both `sponsor` and `disclosure` MUST be present and non-null,
  // non-empty strings. Encoded here as a conditional override.
  allOf: [
    {
      if: {
        type: 'object',
        properties: { tier: { const: 'b2b' } },
        required: ['tier'],
      },
      then: {
        type: 'object',
        required: ['sponsor', 'disclosure'],
        properties: {
          sponsor: { type: 'string', minLength: 1 },
          disclosure: { type: 'string', minLength: 1 },
        },
      },
    },
  ],
};
