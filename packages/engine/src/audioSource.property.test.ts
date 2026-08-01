// Property 9: Audio source selection follows pre-rendered availability and language fallback.
//
// Validates that the reducer correctly dispatches PlaySegment with the
// resolved source (audio/tts), language, and asset path based on the
// MediaCatalog. When mediaCatalog is absent, backward-compatible TTS
// dispatch with conventional segmentId is preserved.
//
// Also validates the 'unavailable' case: when no content exists for a POI,
// the engine must skip it (add to consumed) without stranding.

import * as fc from 'fast-check';
import { property } from '../../../tooling/property';
import { reduce, INITIAL_STATE } from './reducer';
import type { StartTourConfig } from './reducer';
import type { EngineCommand } from './commands';
import type { ActiveState, MediaCatalog } from './state';
import type { Geofence, LatLng } from './types';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const POI_IDS = ['poi-audio', 'poi-tts', 'poi-fallback', 'poi-unavailable', 'poi-any'];

const TEST_GEOFENCES: readonly Geofence[] = POI_IDS.map((id, i) => ({
  poiId: id,
  geometry: {
    kind: 'circle' as const,
    center: [51.0, 17.0 + i * 0.01] as LatLng,
    radiusMeters: 50,
  },
  dwellSec: 3,
  priority: 90 - i * 10,
  authorIndex: i,
}));

const CATALOG: MediaCatalog = {
  defaultLanguage: 'en',
  pois: {
    'poi-audio': {
      narratives: { pl: 'poi-audio:pl', en: 'poi-audio:en' },
      audio: { pl: '/packs/audio/poi-audio.pl.m4a', en: '/packs/audio/poi-audio.en.m4a' },
    },
    'poi-tts': {
      narratives: { pl: 'poi-tts:pl', en: 'poi-tts:en' },
      audio: {},
    },
    'poi-fallback': {
      // No audio in selected 'pl', but has audio in default 'en'
      narratives: { en: 'poi-fallback:en' },
      audio: { en: '/packs/audio/poi-fallback.en.m4a' },
    },
    'poi-unavailable': {
      narratives: {},
      audio: {},
    },
    'poi-any': {
      // No audio/narrative in pl or en, but has fr audio
      narratives: { fr: 'poi-any:fr' },
      audio: { fr: '/packs/audio/poi-any.fr.m4a' },
    },
  },
};

const CONFIG_WITH_CATALOG: StartTourConfig = {
  bundle: { bundleId: 'test', bundleVersion: '1.0.0' },
  geofences: TEST_GEOFENCES,
  route: [
    [51.0, 17.0],
    [51.0, 17.05],
  ],
  language: 'pl',
  mediaCatalog: CATALOG,
};

const CONFIG_NO_CATALOG: StartTourConfig = {
  bundle: { bundleId: 'test', bundleVersion: '1.0.0' },
  geofences: TEST_GEOFENCES,
  route: [
    [51.0, 17.0],
    [51.0, 17.05],
  ],
  language: 'pl',
};

function startTourWith(config: StartTourConfig): ActiveState {
  const { state } = reduce(INITIAL_STATE, { kind: 'UserCommand', cmd: 'start' }, 0, config);
  if (state.phase !== 'Active') throw new Error('Expected Active state after start');
  return state;
}

// ─── Unit tests ─────────────────────────────────────────────────────────────

describe('Property 9: Audio source selection follows pre-rendered availability and language fallback', () => {
  describe('with mediaCatalog', () => {
    it('step 1: prefers pre-rendered audio in selected language', () => {
      const state = startTourWith(CONFIG_WITH_CATALOG);
      const { commands } = reduce(state, { kind: 'GeofenceDwell', poiId: 'poi-audio' }, 1000);
      const play = commands.find(
        (c): c is Extract<EngineCommand, { kind: 'PlaySegment' }> => c.kind === 'PlaySegment',
      );
      expect(play).toBeDefined();
      expect(play!.source).toBe('audio');
      expect(play!.language).toBe('pl');
      expect(play!.assetPath).toBe('/packs/audio/poi-audio.pl.m4a');
      expect(play!.segmentId).toBe('poi-audio:pl');
    });

    it('step 2: falls back to narrative TTS in selected language when no audio', () => {
      const state = startTourWith(CONFIG_WITH_CATALOG);
      const { commands } = reduce(state, { kind: 'GeofenceDwell', poiId: 'poi-tts' }, 1000);
      const play = commands.find(
        (c): c is Extract<EngineCommand, { kind: 'PlaySegment' }> => c.kind === 'PlaySegment',
      );
      expect(play).toBeDefined();
      expect(play!.source).toBe('tts');
      expect(play!.language).toBe('pl');
      expect(play!.assetPath).toBe('poi-tts:pl');
    });

    it('step 3: falls back to pre-rendered audio in default language', () => {
      const state = startTourWith(CONFIG_WITH_CATALOG);
      const { commands } = reduce(state, { kind: 'GeofenceDwell', poiId: 'poi-fallback' }, 1000);
      const play = commands.find(
        (c): c is Extract<EngineCommand, { kind: 'PlaySegment' }> => c.kind === 'PlaySegment',
      );
      expect(play).toBeDefined();
      expect(play!.source).toBe('audio');
      expect(play!.language).toBe('en');
      expect(play!.assetPath).toBe('/packs/audio/poi-fallback.en.m4a');
    });

    it('step 5: falls back to pre-rendered audio in ANY available language', () => {
      const state = startTourWith(CONFIG_WITH_CATALOG);
      const { commands } = reduce(state, { kind: 'GeofenceDwell', poiId: 'poi-any' }, 1000);
      const play = commands.find(
        (c): c is Extract<EngineCommand, { kind: 'PlaySegment' }> => c.kind === 'PlaySegment',
      );
      expect(play).toBeDefined();
      expect(play!.source).toBe('audio');
      expect(play!.language).toBe('fr');
      expect(play!.assetPath).toBe('/packs/audio/poi-any.fr.m4a');
    });

    it('step 7: unavailable POI is consumed without emitting PlaySegment', () => {
      const state = startTourWith(CONFIG_WITH_CATALOG);
      const { state: next, commands } = reduce(
        state,
        { kind: 'GeofenceDwell', poiId: 'poi-unavailable' },
        1000,
      );
      // No PlaySegment emitted.
      const play = commands.find((c) => c.kind === 'PlaySegment');
      expect(play).toBeUndefined();
      // POI is consumed (so it won't re-fire).
      if (next.phase === 'Active') {
        expect(next.session.consumed.has('poi-unavailable')).toBe(true);
        expect(next.session.playing).toBeUndefined();
      }
    });

    it('unavailable POI does not strand the engine in playing', () => {
      const state = startTourWith(CONFIG_WITH_CATALOG);
      const { state: next } = reduce(
        state,
        { kind: 'GeofenceDwell', poiId: 'poi-unavailable' },
        1000,
      );
      if (next.phase === 'Active') {
        expect(next.session.playing).toBeUndefined();
      }
    });
  });

  describe('without mediaCatalog (backward compatible)', () => {
    it('emits TTS with conventional segmentId', () => {
      const state = startTourWith(CONFIG_NO_CATALOG);
      const { commands } = reduce(state, { kind: 'GeofenceDwell', poiId: 'poi-audio' }, 1000);
      const play = commands.find(
        (c): c is Extract<EngineCommand, { kind: 'PlaySegment' }> => c.kind === 'PlaySegment',
      );
      expect(play).toBeDefined();
      expect(play!.source).toBe('tts');
      expect(play!.language).toBe('pl');
      expect(play!.assetPath).toBe('poi-audio:pl');
      expect(play!.segmentId).toBe('poi-audio:pl');
    });
  });

  // ─── Property test: source selection never strands engine ───────────────

  const arbPoiId = fc.constantFrom(...POI_IDS);

  const arbCatalogPresence = fc.boolean();

  property(
    {
      n: 9,
      title:
        'Audio source selection follows pre-rendered availability and language fallback — never strands engine',
    },
    fc.array(arbPoiId, { minLength: 3, maxLength: 20 }),
    arbCatalogPresence,
    (poiIds, hasCatalog) => {
      const config = hasCatalog ? CONFIG_WITH_CATALOG : CONFIG_NO_CATALOG;
      let state = startTourWith(config);
      let now = 1000;

      for (const poiId of poiIds) {
        const result = reduce(state, { kind: 'GeofenceDwell', poiId }, now);
        state = result.state as ActiveState;
        if (state.phase !== 'Active') break;
        now += 100;

        // If a PlaySegment was emitted, simulate AudioFinished.
        const play = result.commands.find((c) => c.kind === 'PlaySegment');
        if (play && play.kind === 'PlaySegment') {
          const finResult = reduce(
            state,
            { kind: 'AudioFinished', segmentId: play.segmentId },
            now,
          );
          state = finResult.state as ActiveState;
          now += 100;
        }
      }

      // Engine must never be stranded: playing must be undefined after all completions.
      if (state.phase === 'Active') {
        if (state.session.playing !== undefined) {
          throw new Error(
            `Engine stranded with playing segment ${state.session.playing.segmentId}`,
          );
        }
      }
    },
    { numRuns: 200 },
  );

  property(
    {
      n: 9,
      title:
        'Audio source selection follows pre-rendered availability and language fallback — consumed set grows for unavailable',
    },
    fc.array(fc.constantFrom('poi-unavailable', 'poi-audio', 'poi-tts'), {
      minLength: 2,
      maxLength: 10,
    }),
    (poiIds) => {
      let state = startTourWith(CONFIG_WITH_CATALOG);
      let now = 1000;

      for (const poiId of poiIds) {
        const result = reduce(state, { kind: 'GeofenceDwell', poiId }, now);
        state = result.state as ActiveState;
        if (state.phase !== 'Active') break;
        now += 100;

        // Complete any playing segment.
        const play = result.commands.find((c) => c.kind === 'PlaySegment');
        if (play && play.kind === 'PlaySegment') {
          const fin = reduce(state, { kind: 'AudioFinished', segmentId: play.segmentId }, now);
          state = fin.state as ActiveState;
          now += 100;
        }
      }

      // Unavailable POIs should always be in consumed after processing.
      if (state.phase === 'Active') {
        // If poi-unavailable was in the list and the engine was active when it
        // arrived (not already consumed), it should be in consumed now.
        const seen = poiIds.includes('poi-unavailable');
        if (seen) {
          expect(state.session.consumed.has('poi-unavailable')).toBe(true);
        }
      }
    },
    { numRuns: 200 },
  );
});
