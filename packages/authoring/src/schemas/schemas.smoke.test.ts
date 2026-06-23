// Smoke test for task 2.1.
//
// Goals:
//   1. Every Authoring_Schema document compiles under Ajv 2020-12.
//   2. A canonical valid example for each schema validates.
//   3. A targeted invalid example for each schema is rejected, and the
//      rejection points at the constraint we mean to enforce (tier enum,
//      ISO 639-1 keying, B2B sponsor+disclosure, CC license id+attribution,
//      entitlement tier `b2b` -> required pre-roll fields).
//
// The full validator lives in task 2.2. This test only proves the schemas
// load and shape rejections correctly. It is intentionally minimal.

import Ajv2020 from 'ajv/dist/2020';

import { manifestSchema } from './manifest';
import { narrativeFrontmatterSchema } from './narrativeFrontmatter';
import { poisSchema } from './pois';
import { routeSchema } from './route';
import { standbyTrackSchema } from './standbyTrack';

function buildAjv(): Ajv2020 {
  // strict: false because some schemas use `examples` and free-form
  // descriptions Ajv would otherwise warn about. allErrors is convenient
  // for diagnosing schema issues during development.
  return new Ajv2020({ strict: false, allErrors: true });
}

describe('Authoring_Schema documents (task 2.1)', () => {
  describe('manifest schema', () => {
    const ajv = buildAjv();
    const validate = ajv.compile(manifestSchema as unknown as object);

    const validManifest = {
      $schema: 'https://schema.tramio.app/manifest/1.json',
      bundleId: 'wroclaw-tram-7-east',
      version: '1.4.2',
      city: { id: 'wroclaw', country: 'PL' },
      transitLine: { gtfsRouteId: '7', direction: 'east', agency: 'MPK' },
      languages: ['pl', 'en'],
      defaultLanguage: 'pl',
      minAppVersion: '1.0.0',
      deadReckoning: { permitted: true, maxLeadSeconds: 30 },
      standbyTracks: ['trivia-architecture'],
      attribution: [
        { kind: 'osm' },
        {
          kind: 'cc',
          license: 'CC-BY-4.0',
          attribution: 'Wikipedia: Wrocław Old Town',
        },
      ],
      checksumAlgorithm: 'sha256',
    };

    it('compiles and accepts a canonical manifest', () => {
      expect(validate(validManifest)).toBe(true);
    });

    it('rejects a CC attribution missing the `attribution` string', () => {
      const bad = {
        ...validManifest,
        attribution: [
          { kind: 'osm' },
          { kind: 'cc', license: 'CC-BY-4.0' }, // missing attribution
        ],
      };
      expect(validate(bad)).toBe(false);
      expect(validate.errors).toBeDefined();
    });

    it('rejects a non-ISO-639-1 language code', () => {
      const bad = { ...validManifest, languages: ['ENG'] }; // 3 letters, uppercase
      expect(validate(bad)).toBe(false);
    });
  });

  describe('route schema', () => {
    const ajv = buildAjv();
    const validate = ajv.compile(routeSchema as unknown as object);

    const validRoute = {
      bundleId: 'wroclaw-tram-7-east',
      polyline: [
        [51.11, 17.03],
        [51.111, 17.032],
      ],
      stops: [
        {
          id: 'stop-001',
          gtfsStopId: '1234',
          coord: [51.11, 17.03],
          scheduledOffsetSec: 0,
        },
      ],
      deviationCorridorMeters: 150,
    };

    it('compiles and accepts a canonical route', () => {
      expect(validate(validRoute)).toBe(true);
    });

    it('rejects out-of-range latitudes', () => {
      const bad = {
        ...validRoute,
        polyline: [
          [200, 17.03], // latitude must be within [-90, 90]
          [51.111, 17.032],
        ],
      };
      expect(validate(bad)).toBe(false);
    });
  });

  describe('pois schema', () => {
    const ajv = buildAjv();
    const validate = ajv.compile(poisSchema as unknown as object);

    const validPois = {
      pois: [
        {
          id: 'poi-rynek',
          category: 'landmark',
          priority: 90,
          geometry: {
            kind: 'circle',
            center: [51.11, 17.031],
            radiusMeters: 60,
          },
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

    it('compiles and accepts a canonical pois.json', () => {
      expect(validate(validPois)).toBe(true);
    });

    it('rejects a tier outside the entitlement enum', () => {
      const bad = {
        pois: [
          {
            ...validPois.pois[0],
            tier: 'premium', // not in {free, time_pass, token_unlock, b2b}
          },
        ],
      };
      expect(validate(bad)).toBe(false);
    });

    it('rejects narratives keyed on a non-ISO-639-1 code', () => {
      const bad = {
        pois: [
          {
            ...validPois.pois[0],
            narratives: { POL: 'narratives/poi-rynek.pl.md' }, // 3 chars, uppercase
          },
        ],
      };
      expect(validate(bad)).toBe(false);
    });

    it('rejects a dwellSec below the 3-second floor (Req 5.3)', () => {
      const bad = {
        pois: [
          {
            ...validPois.pois[0],
            dwellSec: 2,
          },
        ],
      };
      expect(validate(bad)).toBe(false);
    });
  });

  describe('narrative frontmatter schema', () => {
    const ajv = buildAjv();
    const validate = ajv.compile(narrativeFrontmatterSchema as unknown as object);

    it('accepts a non-sponsored narrative with no sponsor/disclosure', () => {
      const ok = {
        poiId: 'poi-rynek',
        language: 'pl',
        durationHintSec: 45,
        sponsor: null,
        disclosure: null,
        licenses: [
          {
            id: 'CC-BY-4.0',
            attribution: 'Photo and text adapted from Wikipedia',
          },
        ],
      };
      expect(validate(ok)).toBe(true);
    });

    it('accepts a B2B narrative carrying sponsor + disclosure', () => {
      const ok = {
        poiId: 'poi-cafe-zamek',
        language: 'en',
        sponsor: 'cafe-zamek',
        disclosure: 'Sponsored by Cafe Zamek.',
        tier: 'b2b',
      };
      expect(validate(ok)).toBe(true);
    });

    it('rejects a B2B narrative missing the disclosure (Req 14.5, 20.4)', () => {
      const bad = {
        poiId: 'poi-cafe-zamek',
        language: 'en',
        sponsor: 'cafe-zamek',
        tier: 'b2b',
      };
      expect(validate(bad)).toBe(false);
      // The conditional `if/then` lives in `allOf`; Ajv reports the missing
      // required field on the inner `then` schema.
      expect(
        validate.errors?.some(
          (e) => e.keyword === 'required' && e.params?.missingProperty === 'disclosure',
        ),
      ).toBe(true);
    });

    it('rejects a B2B narrative with empty sponsor (Req 14.5)', () => {
      const bad = {
        poiId: 'poi-cafe-zamek',
        language: 'en',
        sponsor: '',
        disclosure: 'Sponsored by Cafe Zamek.',
        tier: 'b2b',
      };
      expect(validate(bad)).toBe(false);
    });

    it('rejects a license entry missing attribution (Req 17.2)', () => {
      const bad = {
        poiId: 'poi-rynek',
        language: 'pl',
        licenses: [{ id: 'CC-BY-4.0' }], // attribution missing
      };
      expect(validate(bad)).toBe(false);
    });
  });

  describe('standby track schema', () => {
    const ajv = buildAjv();
    const validate = ajv.compile(standbyTrackSchema as unknown as object);

    const validStandby = {
      id: 'trivia-architecture',
      category: 'trivia',
      languages: ['pl', 'en'],
      narratives: {
        pl: 'standby/trivia-architecture.pl.md',
        en: 'standby/trivia-architecture.en.md',
      },
      audio: { en: 'standby/trivia-architecture.en.m4a' },
      tier: 'free',
      loop: true,
      durationHintSec: 90,
    };

    it('compiles and accepts a canonical standby track', () => {
      expect(validate(validStandby)).toBe(true);
    });

    it('rejects a standby track with no language entries', () => {
      const bad = { ...validStandby, languages: [] };
      expect(validate(bad)).toBe(false);
    });

    it('rejects a standby track with a non-ISO-639-1 narrative key', () => {
      const bad = {
        ...validStandby,
        narratives: { POL: 'standby/trivia-architecture.pl.md' },
      };
      expect(validate(bad)).toBe(false);
    });
  });
});
