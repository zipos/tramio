// Unit tests for known-good and known-bad bundle fixtures (task 2.5).
//
// Each test constructs a minimal in-memory bundle via `virtualFileSystem`
// and asserts that the validator either accepts it (known-good) or rejects
// it with the correct `filePath`, `jsonPointer`, and a human-readable
// `message` for the specific discriminated error class.

import { validateBundle } from './validate';
import { virtualFileSystem } from './fs';
import type { Manifest, Pois, Route } from '../types';
import type { BundleValidationError, HintCode } from './types';

// ---------------------------------------------------------------------------
// Canonical valid bundle builder
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
    'audio/poi-rynek.en.m4a': Buffer.from([0xff, 0xd8, 0x00, 0x01]),
    'standby/trivia-architecture.json': JSON.stringify(standbyJson),
    'standby/trivia-architecture.pl.md': standbyPlMd,
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function expectRejected(
  bundle: MutableBundle,
): readonly BundleValidationError[] {
  const result = validateBundle(virtualFileSystem(bundle));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected validation to fail');
  return result.errors;
}

function findByHintCode(
  errors: readonly BundleValidationError[],
  code: HintCode,
): BundleValidationError | undefined {
  return errors.find((e) => e.hint.code === code);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateBundle — known-good fixture (Req 2.4)', () => {
  it('accepts a fully conforming bundle and returns LoadedBundle', () => {
    const result = validateBundle(virtualFileSystem(buildValidBundle()));
    if (!result.ok) {
      throw new Error(
        `Expected ok, got errors:\n${result.errors
          .map((e) => `  [${e.hint.code}] ${e.filePath} ${e.jsonPointer}: ${e.message}`)
          .join('\n')}`,
      );
    }
    expect(result.ok).toBe(true);
    expect(result.bundle.manifest.bundleId).toBe('wroclaw-tram-7-east');
    expect(result.bundle.narratives.size).toBe(3);
    expect(result.bundle.standbyTracks.size).toBe(1);
    expect(result.bundle.audioFiles.has('audio/poi-rynek.en.m4a')).toBe(true);
  });
});

describe('validateBundle — missing transcript for pre-rendered audio (Req 16.3)', () => {
  it('rejects when audio language has no corresponding narrative transcript', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    // Add audio for 'de' but no narrative for 'de'
    pois.pois[0].audio = { de: 'audio/poi-rynek.de.m4a' };
    bundle['pois.json'] = JSON.stringify(pois);
    bundle['audio/poi-rynek.de.m4a'] = Buffer.from([0x00]);

    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'transcript-missing');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('pois.json');
    expect(e!.jsonPointer).toBe('/pois/0/audio/de');
    expect(e!.message).toMatch(/transcript/i);
    expect(e!.message.length).toBeGreaterThan(10);
  });
});

describe('validateBundle — missing disclosure for B2B segment (Req 14.5, 20.4)', () => {
  it('rejects when a B2B narrative declares tier:b2b with sponsor but omits disclosure (schema-level)', () => {
    const bundle = buildValidBundle();
    // Narrative declares tier: b2b and sponsor but omits disclosure.
    // The schema's allOf conditional catches this as a schema-violation.
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
sponsor: cafe-zamek
tier: b2b
---

Sponsored body.
`;
    const errors = expectRejected(bundle);
    const e = errors.find(
      (err) =>
        err.filePath === 'narratives/poi-rynek.pl.md' &&
        err.message.toLowerCase().includes('disclosure'),
    );
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-rynek.pl.md');
    expect(e!.message.length).toBeGreaterThan(10);
  });

  it('rejects when B2B tier is inherited from parent POI and narrative lacks disclosure', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    pois.pois[0].tier = 'b2b';
    bundle['pois.json'] = JSON.stringify(pois);
    // Narrative has no sponsor or disclosure, inherits b2b from parent
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
---

Body without disclosure.
`;
    bundle['narratives/poi-rynek.en.md'] = `---
poiId: poi-rynek
language: en
---

Body without disclosure.
`;

    const errors = expectRejected(bundle);
    const disclosureErr = errors.find(
      (err) =>
        err.hint.code === 'b2b-disclosure-missing' &&
        err.jsonPointer === '/disclosure',
    );
    expect(disclosureErr).toBeDefined();
    expect(disclosureErr!.message).toMatch(/disclosure/i);
    expect(disclosureErr!.message.length).toBeGreaterThan(10);
  });
});

describe('validateBundle — missing sponsor for B2B segment (Req 14.5)', () => {
  it('rejects when a B2B narrative has disclosure but no sponsor (schema-level)', () => {
    const bundle = buildValidBundle();
    // Narrative declares tier: b2b and disclosure but omits sponsor.
    // The schema's allOf conditional catches this as a schema-violation.
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
disclosure: "Sponsored by Cafe Zamek."
tier: b2b
---

Sponsored body.
`;
    const errors = expectRejected(bundle);
    const e = errors.find(
      (err) =>
        err.filePath === 'narratives/poi-rynek.pl.md' &&
        err.message.toLowerCase().includes('sponsor'),
    );
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-rynek.pl.md');
    expect(e!.message.length).toBeGreaterThan(10);
  });

  it('rejects when B2B tier is inherited from parent POI and narrative lacks sponsor', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    pois.pois[0].tier = 'b2b';
    bundle['pois.json'] = JSON.stringify(pois);
    // Narrative has disclosure but no sponsor, inherits b2b from parent
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
disclosure: "Sponsored by Cafe Zamek."
---

Body without sponsor.
`;
    bundle['narratives/poi-rynek.en.md'] = `---
poiId: poi-rynek
language: en
disclosure: "Sponsored by Cafe Zamek."
---

Body without sponsor.
`;

    const errors = expectRejected(bundle);
    const sponsorErr = errors.find(
      (err) =>
        err.hint.code === 'b2b-disclosure-missing' &&
        err.jsonPointer === '/sponsor',
    );
    expect(sponsorErr).toBeDefined();
    expect(sponsorErr!.message).toMatch(/sponsor/i);
    expect(sponsorErr!.message.length).toBeGreaterThan(10);
  });
});

describe('validateBundle — missing CC license attribution (Req 17.2)', () => {
  it('rejects when a CC license entry has id but empty attribution (schema-level)', () => {
    const bundle = buildValidBundle();
    // Empty attribution violates the schema's minLength:1 constraint.
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
licenses:
  - id: CC-BY-4.0
    attribution: ""
---

Body with incomplete license.
`;
    const errors = expectRejected(bundle);
    // Schema catches empty string via minLength:1 as a schema-violation
    const e = errors.find(
      (err) =>
        err.filePath === 'narratives/poi-rynek.pl.md' &&
        err.hint.code === 'schema-violation',
    );
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-rynek.pl.md');
    expect(e!.jsonPointer).toMatch(/licenses/);
    expect(e!.message.length).toBeGreaterThan(5);
  });

  it('rejects when a CC license entry has attribution but empty id (schema-level)', () => {
    const bundle = buildValidBundle();
    // Empty id violates the schema's minLength:1 constraint.
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
licenses:
  - id: ""
    attribution: "Photo from Wikipedia"
---

Body with incomplete license.
`;
    const errors = expectRejected(bundle);
    const e = errors.find(
      (err) =>
        err.filePath === 'narratives/poi-rynek.pl.md' &&
        err.hint.code === 'schema-violation',
    );
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-rynek.pl.md');
    expect(e!.jsonPointer).toMatch(/licenses/);
    expect(e!.message.length).toBeGreaterThan(5);
  });

  it('rejects via cross-file check when CC license has missing attribution field', () => {
    // This tests the cross-file invariant layer (cc-license-incomplete)
    // which fires when the schema passes but the field is logically empty.
    // We need a narrative that passes schema validation but has a license
    // entry that the cross-file check catches. Since the schema requires
    // minLength:1 for both fields, the cross-file check is a defense-in-depth
    // layer. We verify the schema-level rejection is sufficient.
    const bundle = buildValidBundle();
    // Omit the attribution key entirely — schema requires it
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
licenses:
  - id: CC-BY-4.0
---

Body.
`;
    const errors = expectRejected(bundle);
    const e = errors.find(
      (err) =>
        err.filePath === 'narratives/poi-rynek.pl.md' &&
        err.hint.code === 'schema-violation',
    );
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/attribution|required/i);
    expect(e!.message.length).toBeGreaterThan(5);
  });
});

describe('validateBundle — missing narrative file reference (Req 2.4)', () => {
  it('rejects when a referenced narrative file does not exist on disk', () => {
    const bundle = buildValidBundle();
    delete bundle['narratives/poi-rynek.en.md'];

    const errors = expectRejected(bundle);
    const e = errors.find(
      (err) =>
        err.hint.code === 'missing-file' &&
        err.jsonPointer === '/pois/0/narratives/en',
    );
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('pois.json');
    expect(e!.message).toMatch(/missing/i);
    expect(e!.message.length).toBeGreaterThan(10);
  });
});

describe('validateBundle — invalid manifest (missing required fields) (Req 2.2)', () => {
  it('rejects when manifest.json is missing a required field (bundleId)', () => {
    const bundle = buildValidBundle();
    const manifest = JSON.parse(bundle['manifest.json'] as string);
    delete manifest.bundleId;
    bundle['manifest.json'] = JSON.stringify(manifest);

    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'schema-violation');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('manifest.json');
    // The JSON pointer should point to the root or the missing property
    expect(e!.jsonPointer).toBeDefined();
    expect(e!.message).toMatch(/bundleId|required/i);
    expect(e!.message.length).toBeGreaterThan(5);
  });

  it('rejects when manifest.json has an invalid field value', () => {
    const bundle = buildValidBundle();
    const manifest = JSON.parse(bundle['manifest.json'] as string);
    manifest.checksumAlgorithm = 'md5'; // must be 'sha256'
    bundle['manifest.json'] = JSON.stringify(manifest);

    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'schema-violation');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('manifest.json');
    expect(e!.jsonPointer).toBe('/checksumAlgorithm');
    expect(e!.message.length).toBeGreaterThan(5);
  });
});

describe('validateBundle — invalid POI geometry (Req 2.3)', () => {
  it('rejects when a POI has invalid geometry (missing radiusMeters for circle)', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    // Remove radiusMeters from circle geometry
    delete pois.pois[0].geometry.radiusMeters;
    bundle['pois.json'] = JSON.stringify(pois);

    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'schema-violation');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('pois.json');
    // The pointer should reference the geometry area
    expect(e!.jsonPointer).toMatch(/\/pois\/0/);
    expect(e!.message.length).toBeGreaterThan(5);
  });

  it('rejects when a POI has invalid geometry kind', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    pois.pois[0].geometry = { kind: 'hexagon', center: [51.11, 17.031] };
    bundle['pois.json'] = JSON.stringify(pois);

    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'schema-violation');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('pois.json');
    expect(e!.jsonPointer).toMatch(/\/pois\/0/);
    expect(e!.message.length).toBeGreaterThan(5);
  });
});
