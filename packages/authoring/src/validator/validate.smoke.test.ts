// Smoke tests for the Content_Bundle validator (task 2.2).
//
// Goals (full property + per-error-class coverage live in tasks 2.4 / 2.5):
//   1. A canonical, in-memory valid bundle is accepted and produces a
//      LoadedBundle with the expected populated maps.
//   2. Each major cross-file invariant is exercised once on a mutated
//      copy of the canonical bundle to prove the validator rejects with
//      a structured `BundleValidationError` carrying `filePath` +
//      `jsonPointer` + `message` + `hint`.

import { validateBundle } from './validate';
import { virtualFileSystem } from './fs';
import type { Manifest, Pois, Route } from '../types';

// Mutable bundle record used in tests so individual cases can clone +
// mutate the canonical fixture per scenario.
type MutableBundle = Record<string, string | Buffer>;

// ---------------------------------------------------------------------------
// Canonical valid bundle (one POI, one standby track, one B2B deeperLayer)
// ---------------------------------------------------------------------------

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
    {
      id: 'stop-002',
      gtfsStopId: '1235',
      coord: [51.114, 17.041],
      scheduledOffsetSec: 180,
    },
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
// Tests
// ---------------------------------------------------------------------------

describe('validateBundle (task 2.2) — smoke', () => {
  it('accepts a canonical bundle and returns a populated LoadedBundle', () => {
    const result = validateBundle(virtualFileSystem(buildValidBundle()));
    if (!result.ok) {
      // Surface diagnostics so a failure points at the regression.
      throw new Error(
        `Expected ok, got errors:\n${result.errors
          .map((e) => `  - ${e.filePath} ${e.jsonPointer} :: ${e.message}`)
          .join('\n')}`,
      );
    }
    expect(result.bundle.manifest.bundleId).toBe('wroclaw-tram-7-east');
    expect(result.bundle.narratives.size).toBe(3); // pl, en, standby pl
    expect(result.bundle.standbyTracks.size).toBe(1);
    expect(result.bundle.audioFiles.has('audio/poi-rynek.en.m4a')).toBe(true);
  });

  it('rejects audio without a transcript pair (Req 16.3)', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    pois.pois[0].audio = { de: 'audio/poi-rynek.de.m4a' }; // de not in narratives
    const result = validateBundle(
      virtualFileSystem({ ...bundle, 'pois.json': JSON.stringify(pois) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const transcript = result.errors.find((e) => e.hint.code === 'transcript-missing');
    expect(transcript).toBeDefined();
    expect(transcript?.filePath).toBe('pois.json');
    expect(transcript?.jsonPointer).toBe('/pois/0/audio/de');
  });

  it('rejects a missing narrative file', () => {
    const bundle = buildValidBundle();
    delete bundle['narratives/poi-rynek.en.md'];
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const missing = result.errors.find((e) => e.hint.code === 'missing-file');
    expect(missing).toBeDefined();
    expect(missing?.filePath).toBe('pois.json');
    expect(missing?.jsonPointer).toBe('/pois/0/narratives/en');
  });

  it('rejects a missing audio file', () => {
    const bundle = buildValidBundle();
    delete bundle['audio/poi-rynek.en.m4a'];
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const missing = result.errors.find(
      (e) =>
        e.hint.code === 'missing-file' && e.jsonPointer === '/pois/0/audio/en',
    );
    expect(missing).toBeDefined();
  });

  it('rejects a B2B narrative without disclosure (Req 14.5, 20.4)', () => {
    const bundle = buildValidBundle();
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
sponsor: cafe-zamek
tier: b2b
---

Sponsored body.
`;
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Schema layer flags the missing required `disclosure` first; the
    // hint code is `schema-violation`, but the filePath + jsonPointer
    // must still pin the offending narrative file.
    const offender = result.errors.find(
      (e) =>
        e.filePath === 'narratives/poi-rynek.pl.md' &&
        e.message.toLowerCase().includes('disclosure'),
    );
    expect(offender).toBeDefined();
  });

  it('rejects a B2B narrative whose tier is inherited from the parent POI', () => {
    const bundle = buildValidBundle();
    // Parent POI declares b2b; narrative omits sponsor + disclosure.
    const pois = JSON.parse(bundle['pois.json'] as string);
    pois.pois[0].tier = 'b2b';
    bundle['pois.json'] = JSON.stringify(pois);
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
---

Body.
`;
    bundle['narratives/poi-rynek.en.md'] = `---
poiId: poi-rynek
language: en
---

Body.
`;
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const cascade = result.errors.find((e) => e.hint.code === 'b2b-disclosure-missing');
    expect(cascade).toBeDefined();
  });

  it('rejects defaultLanguage missing from manifest.languages', () => {
    const bundle = buildValidBundle();
    const manifest = JSON.parse(bundle['manifest.json'] as string);
    manifest.defaultLanguage = 'de';
    bundle['manifest.json'] = JSON.stringify(manifest);
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offender = result.errors.find(
      (e) => e.hint.code === 'default-language-missing-from-languages',
    );
    expect(offender?.filePath).toBe('manifest.json');
    expect(offender?.jsonPointer).toBe('/defaultLanguage');
  });

  it('rejects a POI missing a narrative for the default language', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    delete pois.pois[0].narratives.pl; // default lang
    bundle['pois.json'] = JSON.stringify(pois);
    delete bundle['narratives/poi-rynek.pl.md'];
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offender = result.errors.find(
      (e) => e.hint.code === 'default-language-narrative-missing',
    );
    expect(offender).toBeDefined();
    expect(offender?.filePath).toBe('pois.json');
  });

  it('rejects duplicate POI ids', () => {
    const bundle = buildValidBundle();
    const pois = JSON.parse(bundle['pois.json'] as string);
    pois.pois.push({ ...pois.pois[0] });
    bundle['pois.json'] = JSON.stringify(pois);
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const dup = result.errors.find(
      (e) => e.hint.code === 'duplicate-id' && e.filePath === 'pois.json',
    );
    expect(dup?.jsonPointer).toBe('/pois/1/id');
  });

  it('rejects duplicate GTFS stop ids within a route', () => {
    const bundle = buildValidBundle();
    const route = JSON.parse(bundle['route.json'] as string);
    route.stops[1].gtfsStopId = route.stops[0].gtfsStopId;
    bundle['route.json'] = JSON.stringify(route);
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const dup = result.errors.find(
      (e) => e.hint.code === 'duplicate-id' && e.filePath === 'route.json',
    );
    expect(dup?.jsonPointer).toBe('/stops/1/gtfsStopId');
  });

  it('rejects a manifest standby track id with no on-disk file', () => {
    const bundle = buildValidBundle();
    delete bundle['standby/trivia-architecture.json'];
    delete bundle['standby/trivia-architecture.pl.md'];
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offender = result.errors.find((e) => e.hint.code === 'standby-file-missing');
    expect(offender?.filePath).toBe('manifest.json');
    expect(offender?.jsonPointer).toBe('/standbyTracks/0');
  });

  it('rejects a CC license entry without attribution (Req 17.2)', () => {
    const bundle = buildValidBundle();
    bundle['narratives/poi-rynek.pl.md'] = `---
poiId: poi-rynek
language: pl
licenses:
  - id: CC-BY-4.0
---

Body.
`;
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offender = result.errors.find(
      (e) => e.filePath === 'narratives/poi-rynek.pl.md',
    );
    expect(offender).toBeDefined();
  });

  it('rejects schema-invalid manifest.json with a JSON pointer to the offending field', () => {
    const bundle = buildValidBundle();
    const manifest = JSON.parse(bundle['manifest.json'] as string);
    manifest.checksumAlgorithm = 'md5'; // const violation
    bundle['manifest.json'] = JSON.stringify(manifest);
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offender = result.errors.find(
      (e) => e.filePath === 'manifest.json' && e.hint.code === 'schema-violation',
    );
    expect(offender).toBeDefined();
    expect(offender?.jsonPointer).toBe('/checksumAlgorithm');
  });

  it('reports a parse error with no jsonPointer when the JSON is malformed', () => {
    const bundle = buildValidBundle();
    bundle['pois.json'] = '{ not valid json';
    const result = validateBundle(virtualFileSystem(bundle));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const offender = result.errors.find(
      (e) => e.filePath === 'pois.json' && e.hint.code === 'parse-error',
    );
    expect(offender).toBeDefined();
    expect(offender?.jsonPointer).toBe('');
  });
});
