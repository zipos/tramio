// Property-based test for the Authoring_Schema validator (task 2.4).
//
// Feature: urban-narrative-mvp, Property 13: Authoring_Schema validator
// rejects all violations and accepts all conforming bundles
//
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 14.1, 16.3, 17.2**
//
// Strategy:
//   1. Start with a known-valid bundle (passes validation).
//   2. Apply exactly one mutation per run from a set of mutation strategies.
//   3. Assert the mutated bundle is rejected by the validator.
//   4. Assert the error points to the correct file path and JSON pointer.
//   5. Also assert that the unmutated bundle is always accepted.

import * as fc from 'fast-check';
import { validateBundle } from './validate';
import { virtualFileSystem } from './fs';
import type { Manifest, Pois, Route } from '../types';

// ---------------------------------------------------------------------------
// Canonical valid bundle (mirrors the smoke test fixture)
// ---------------------------------------------------------------------------

type MutableBundle = Record<string, string | Buffer>;

const validManifest: Manifest = {
  bundleId: 'wroclaw-tram-7-east',
  version: '1.0.0',
  city: { id: 'wroclaw', country: 'PL' },
  transitLine: { gtfsRouteId: '7', direction: 'east', agency: 'MPK' },
  languages: ['pl', 'en'],
  defaultLanguage: 'pl',
  minAppVersion: '1.0.0',
  deadReckoning: { permitted: true, maxLeadSeconds: 30 },
  standbyTracks: ['trivia-architecture'],
  attribution: [
    { kind: 'osm' },
    { kind: 'cc', license: 'CC-BY-4.0', attribution: 'Wikipedia: Wroclaw Old Town' },
  ],
  checksumAlgorithm: 'sha256',
};

const validRoute: Route = {
  bundleId: 'wroclaw-tram-7-east',
  polyline: [
    [51.11, 17.03],
    [51.111, 17.032],
  ],
  stops: [
    { id: 'stop-001', gtfsStopId: '1234', coord: [51.11, 17.03], scheduledOffsetSec: 0 },
    { id: 'stop-002', gtfsStopId: '1235', coord: [51.114, 17.041], scheduledOffsetSec: 180 },
  ],
  deviationCorridorMeters: 150,
};

const validPois: Pois = {
  pois: [
    {
      id: 'poi-rynek',
      category: 'landmark',
      priority: 90,
      geometry: { kind: 'circle', center: [51.11, 17.031], radiusMeters: 60 },
      directionFilter: { kind: 'alongRoute', tolerance: 30 },
      dwellSec: 3,
      deferrable: true,
      drPermitted: true,
      tier: 'free',
      narratives: {
        pl: 'narratives/poi-rynek.pl.md',
        en: 'narratives/poi-rynek.en.md',
      },
      audio: { en: 'audio/poi-rynek.en.m4a' },
    },
  ],
};

const standbyJson = {
  id: 'trivia-architecture',
  category: 'trivia',
  languages: ['pl'],
  narratives: { pl: 'standby/trivia-architecture.pl.md' },
  tier: 'free',
};

const narrativePlMd = `---
poiId: poi-rynek
language: pl
durationHintSec: 45
sponsor: null
disclosure: null
licenses:
  - id: CC-BY-4.0
    attribution: Photo and text adapted from Wikipedia
---

# Rynek

Plac otoczony XIII-wiecznymi kamienicami.
`;

const narrativeEnMd = `---
poiId: poi-rynek
language: en
durationHintSec: 45
---

# Rynek

A 13th-century market square.
`;

const standbyPlMd = `---
poiId: trivia-architecture
language: pl
---

Wieże, cegła, witraże.
`;

function buildValidBundle(): MutableBundle {
  return {
    'manifest.json': JSON.stringify(validManifest),
    'route.json': JSON.stringify(validRoute),
    'pois.json': JSON.stringify(validPois),
    'narratives/poi-rynek.pl.md': narrativePlMd,
    'narratives/poi-rynek.en.md': narrativeEnMd,
    'audio/poi-rynek.en.m4a': Buffer.from([0, 0, 0, 0]),
    'standby/trivia-architecture.json': JSON.stringify(standbyJson),
    'standby/trivia-architecture.pl.md': standbyPlMd,
  };
}

// ---------------------------------------------------------------------------
// Mutation strategies
// ---------------------------------------------------------------------------

/**
 * Each mutation describes:
 *   - `name`: human-readable label for debugging
 *   - `apply`: transforms a valid bundle into an invalid one
 *   - `expectedFilePath`: the file the error should point to
 *   - `expectedPointerPrefix`: the JSON pointer (or prefix) the error should contain
 */
interface Mutation {
  name: string;
  apply: (bundle: MutableBundle) => void;
  expectedFilePath: string;
  expectedPointerPrefix: string;
}

const mutations: Mutation[] = [
  // --- Drop required fields ---
  {
    name: 'drop manifest.bundleId (required field)',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      delete m.bundleId;
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '',
  },
  {
    name: 'drop manifest.version (required field)',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      delete m.version;
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '',
  },
  {
    name: 'drop manifest.languages (required field)',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      delete m.languages;
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '',
  },
  {
    name: 'drop manifest.checksumAlgorithm (required field)',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      delete m.checksumAlgorithm;
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '',
  },
  {
    name: 'drop poi.id (required field)',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      delete p.pois[0].id;
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0',
  },
  {
    name: 'drop poi.geometry (required field)',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      delete p.pois[0].geometry;
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0',
  },
  {
    name: 'drop poi.narratives (required field)',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      delete p.pois[0].narratives;
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0',
  },
  {
    name: 'drop route.polyline (required field)',
    apply: (b) => {
      const r = JSON.parse(b['route.json'] as string);
      delete r.polyline;
      b['route.json'] = JSON.stringify(r);
    },
    expectedFilePath: 'route.json',
    expectedPointerPrefix: '',
  },
  {
    name: 'drop route.stops (required field)',
    apply: (b) => {
      const r = JSON.parse(b['route.json'] as string);
      delete r.stops;
      b['route.json'] = JSON.stringify(r);
    },
    expectedFilePath: 'route.json',
    expectedPointerPrefix: '',
  },

  // --- Retype (wrong type for a field) ---
  {
    name: 'retype manifest.version to number',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      m.version = 123;
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '/version',
  },
  {
    name: 'retype manifest.languages to string',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      m.languages = 'pl';
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '/languages',
  },
  {
    name: 'retype poi.priority to string',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      p.pois[0].priority = 'high';
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/priority',
  },
  {
    name: 'retype poi.dwellSec to string',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      p.pois[0].dwellSec = 'three';
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/dwellSec',
  },
  {
    name: 'retype route.deviationCorridorMeters to boolean',
    apply: (b) => {
      const r = JSON.parse(b['route.json'] as string);
      r.deviationCorridorMeters = true;
      b['route.json'] = JSON.stringify(r);
    },
    expectedFilePath: 'route.json',
    expectedPointerPrefix: '/deviationCorridorMeters',
  },

  // --- Out-of-range values ---
  {
    name: 'poi.dwellSec below minimum (< 3)',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      p.pois[0].dwellSec = 1;
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/dwellSec',
  },
  {
    name: 'poi.priority above maximum (> 1000)',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      p.pois[0].priority = 1500;
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/priority',
  },
  {
    name: 'manifest.checksumAlgorithm invalid const value',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      m.checksumAlgorithm = 'md5';
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '/checksumAlgorithm',
  },
  {
    name: 'poi.tier invalid enum value',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      p.pois[0].tier = 'premium';
      b['pois.json'] = JSON.stringify(p);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/tier',
  },
  {
    name: 'manifest.defaultLanguage invalid pattern (not ISO 639-1)',
    apply: (b) => {
      const m = JSON.parse(b['manifest.json'] as string);
      m.defaultLanguage = 'PLX'; // not 2 lowercase letters
      b['manifest.json'] = JSON.stringify(m);
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '/defaultLanguage',
  },

  // --- Drop transcript for pre-rendered audio (Req 16.3) ---
  {
    name: 'audio without transcript (drop narrative for audio language)',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      // Add audio for 'de' but no narrative for 'de'
      p.pois[0].audio = { ...p.pois[0].audio, de: 'audio/poi-rynek.de.m4a' };
      b['pois.json'] = JSON.stringify(p);
      b['audio/poi-rynek.de.m4a'] = Buffer.from([0, 0, 0, 0]);
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/audio/de',
  },

  // --- Drop license for CC content (Req 17.2) ---
  {
    name: 'CC license entry missing attribution',
    apply: (b) => {
      b['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
licenses:
  - id: CC-BY-4.0
---

Body.
`;
    },
    expectedFilePath: 'narratives/poi-rynek.pl.md',
    expectedPointerPrefix: '/licenses/0',
  },
  {
    name: 'CC license entry missing id',
    apply: (b) => {
      b['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
licenses:
  - attribution: Some attribution
---

Body.
`;
    },
    expectedFilePath: 'narratives/poi-rynek.pl.md',
    expectedPointerPrefix: '/licenses/0',
  },

  // --- Drop disclosure for B2B (Req 14.5, 20.4) ---
  // Note: When the narrative itself declares `tier: b2b`, the JSON Schema
  // `allOf[0].then.required` check fires at the root of the frontmatter
  // object, so Ajv reports the pointer as "" (root). The cross-file check
  // in validate.ts reports `/disclosure` or `/sponsor` only when the tier
  // is *inherited* from the parent POI (schema passes but cross-file fails).
  {
    name: 'B2B narrative missing disclosure (schema-level)',
    apply: (b) => {
      b['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
tier: b2b
sponsor: cafe-zamek
---

Sponsored body.
`;
    },
    expectedFilePath: 'narratives/poi-rynek.pl.md',
    expectedPointerPrefix: '',
  },
  {
    name: 'B2B narrative missing sponsor (schema-level)',
    apply: (b) => {
      b['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
tier: b2b
disclosure: Sponsored by Cafe Zamek.
---

Sponsored body.
`;
    },
    expectedFilePath: 'narratives/poi-rynek.pl.md',
    expectedPointerPrefix: '',
  },
  {
    name: 'B2B inherited from parent POI, narrative missing sponsor+disclosure',
    apply: (b) => {
      const p = JSON.parse(b['pois.json'] as string);
      p.pois[0].tier = 'b2b';
      b['pois.json'] = JSON.stringify(p);
      // Narratives don't declare tier, so they inherit b2b from parent
      b['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
---

Body.
`;
      b['narratives/poi-rynek.en.md'] = `---
poiId: poi-rynek
language: en
---

Body.
`;
    },
    expectedFilePath: 'narratives/poi-rynek.pl.md',
    expectedPointerPrefix: '/sponsor',
  },

  // --- Missing file references ---
  {
    name: 'narrative file referenced but missing from bundle',
    apply: (b) => {
      delete b['narratives/poi-rynek.en.md'];
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/narratives/en',
  },
  {
    name: 'audio file referenced but missing from bundle',
    apply: (b) => {
      delete b['audio/poi-rynek.en.m4a'];
    },
    expectedFilePath: 'pois.json',
    expectedPointerPrefix: '/pois/0/audio/en',
  },
  {
    name: 'standby track JSON file missing from bundle',
    apply: (b) => {
      delete b['standby/trivia-architecture.json'];
      delete b['standby/trivia-architecture.pl.md'];
    },
    expectedFilePath: 'manifest.json',
    expectedPointerPrefix: '/standbyTracks/0',
  },
];

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 13: Authoring_Schema validator rejects all violations and accepts all conforming bundles', () => {
  // Precondition: the unmutated bundle is always accepted.
  it('accepts the unmutated valid bundle (baseline)', () => {
    const result = validateBundle(virtualFileSystem(buildValidBundle()));
    if (!result.ok) {
      throw new Error(
        `Expected valid bundle to pass, got errors:\n${result.errors
          .map((e) => `  - ${e.filePath} ${e.jsonPointer} :: ${e.message}`)
          .join('\n')}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it('rejects every single-mutation violation and reports the correct file path and JSON pointer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: mutations.length - 1 }),
        (mutationIndex) => {
          const mutation = mutations[mutationIndex]!;

          // 1. Verify the unmutated bundle passes (sanity check per run).
          const baseResult = validateBundle(virtualFileSystem(buildValidBundle()));
          if (!baseResult.ok) {
            return false; // Should never happen; fail fast.
          }

          // 2. Apply exactly one mutation.
          const bundle = buildValidBundle();
          mutation.apply(bundle);

          // 3. Assert the mutated bundle is rejected.
          const result = validateBundle(virtualFileSystem(bundle));
          if (result.ok) {
            throw new Error(
              `Mutation "${mutation.name}" was NOT rejected by the validator. ` +
                `Expected rejection with error at ${mutation.expectedFilePath} ` +
                `${mutation.expectedPointerPrefix}`,
            );
          }

          // 4. Assert at least one error points to the expected file path.
          const matchingFileErrors = result.errors.filter(
            (e) => e.filePath === mutation.expectedFilePath,
          );
          if (matchingFileErrors.length === 0) {
            throw new Error(
              `Mutation "${mutation.name}" was rejected, but no error points to ` +
                `file "${mutation.expectedFilePath}". Errors:\n` +
                result.errors
                  .map((e) => `  - ${e.filePath} ${e.jsonPointer} :: ${e.message}`)
                  .join('\n'),
            );
          }

          // 5. Assert at least one error's JSON pointer starts with the expected prefix.
          const matchingPointerErrors = matchingFileErrors.filter((e) =>
            e.jsonPointer.startsWith(mutation.expectedPointerPrefix),
          );
          if (matchingPointerErrors.length === 0) {
            throw new Error(
              `Mutation "${mutation.name}" was rejected at file "${mutation.expectedFilePath}", ` +
                `but no error's JSON pointer starts with "${mutation.expectedPointerPrefix}". ` +
                `Pointers found:\n` +
                matchingFileErrors
                  .map((e) => `  - ${e.jsonPointer} :: ${e.message}`)
                  .join('\n'),
            );
          }

          return true;
        },
      ),
      { numRuns: 200, seed: 42 },
    );
  });
});
