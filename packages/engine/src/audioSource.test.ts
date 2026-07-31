// Unit tests for audio source selection (selectAudioSource).
//
// Covers the six-step fallback chain and the 'unavailable' discriminant
// introduced in FIX 5. The function MUST never return an empty assetPath;
// when no content exists it returns { source: 'unavailable' } so the caller
// can skip the POI explicitly.
//
// @see design.md Property 9: "Audio source selection follows pre-rendered
//      availability and language fallback"
// @see Requirement 1.1

import { selectAudioSource, type AudioSourceResult } from './audioSource';

describe('selectAudioSource', () => {
  const POI_ID = 'poi-palace';

  describe('primary chain (steps 1–4)', () => {
    it('step 1: returns pre-rendered audio in selected language', () => {
      const result = selectAudioSource(
        POI_ID,
        'pl',
        'en',
        { pl: '/narratives/pl.md', en: '/narratives/en.md' },
        { pl: '/audio/pl.aac', en: '/audio/en.aac' },
      );
      expect(result).toEqual({ source: 'audio', language: 'pl', assetPath: '/audio/pl.aac' });
    });

    it('step 2: falls back to narrative TTS in selected language', () => {
      const result = selectAudioSource(
        POI_ID,
        'pl',
        'en',
        { pl: '/narratives/pl.md', en: '/narratives/en.md' },
        { en: '/audio/en.aac' }, // no audio in 'pl'
      );
      expect(result).toEqual({ source: 'tts', language: 'pl', assetPath: '/narratives/pl.md' });
    });

    it('step 3: falls back to pre-rendered audio in default language', () => {
      const result = selectAudioSource(
        POI_ID,
        'de', // selected language not available at all
        'en',
        { en: '/narratives/en.md' },
        { en: '/audio/en.aac' },
      );
      expect(result).toEqual({ source: 'audio', language: 'en', assetPath: '/audio/en.aac' });
    });

    it('step 4: falls back to narrative TTS in default language', () => {
      const result = selectAudioSource(
        POI_ID,
        'de',
        'en',
        { en: '/narratives/en.md' },
        undefined, // no audio at all
      );
      expect(result).toEqual({ source: 'tts', language: 'en', assetPath: '/narratives/en.md' });
    });
  });

  describe('extended fallback chain (steps 5–7, FIX 5)', () => {
    it('step 5: falls back to pre-rendered audio in ANY available language', () => {
      // Neither selected ('de') nor default ('en') have content, but 'fr' does
      const result = selectAudioSource(
        POI_ID,
        'de',
        'en',
        {}, // no narratives
        { fr: '/audio/fr.aac' },
      );
      expect(result).toEqual({ source: 'audio', language: 'fr', assetPath: '/audio/fr.aac' });
    });

    it('step 5: prefers pre-rendered audio over narrative in any-language fallback', () => {
      // Neither 'de' nor 'en' have content; both 'fr' audio and 'ja' narrative exist
      const result = selectAudioSource(
        POI_ID,
        'de',
        'en',
        { ja: '/narratives/ja.md' },
        { fr: '/audio/fr.aac' },
      );
      // Audio is preferred (step 5 before step 6)
      expect(result).toEqual({ source: 'audio', language: 'fr', assetPath: '/audio/fr.aac' });
    });

    it('step 6: falls back to narrative TTS in ANY available language', () => {
      const result = selectAudioSource(
        POI_ID,
        'de',
        'en',
        { ja: '/narratives/ja.md' },
        undefined, // no audio at all
      );
      expect(result).toEqual({ source: 'tts', language: 'ja', assetPath: '/narratives/ja.md' });
    });

    it('step 6: also works when audio map exists but is empty for available languages', () => {
      const result = selectAudioSource(
        POI_ID,
        'de',
        'en',
        { ja: '/narratives/ja.md' },
        {}, // audio map exists but empty
      );
      expect(result).toEqual({ source: 'tts', language: 'ja', assetPath: '/narratives/ja.md' });
    });

    it('step 7: returns unavailable when no content exists at all', () => {
      const result = selectAudioSource(POI_ID, 'de', 'en', {}, undefined);
      expect(result).toEqual({ source: 'unavailable' });
    });

    it('step 7: returns unavailable with empty audio map and empty narratives', () => {
      const result = selectAudioSource(POI_ID, 'de', 'en', {}, {});
      expect(result).toEqual({ source: 'unavailable' });
    });

    it('never returns an empty assetPath for audio or tts sources', () => {
      // The specific bug case: narratives has no entry for selected or default language
      const result: AudioSourceResult = selectAudioSource(POI_ID, 'fr', 'en', {
        pl: '/narratives/pl.md',
      });
      expect(result.source).not.toBe('unavailable');
      if (result.source !== 'unavailable') {
        expect(result.assetPath).not.toBe('');
        expect(result.assetPath.length).toBeGreaterThan(0);
      }
    });
  });

  describe('type narrowing', () => {
    it('unavailable result has no language or assetPath fields', () => {
      const result = selectAudioSource(POI_ID, 'de', 'en', {});
      expect(result.source).toBe('unavailable');
      // Type narrowing: 'unavailable' does not carry language/assetPath
      if (result.source === 'unavailable') {
        expect('language' in result).toBe(false);
        expect('assetPath' in result).toBe(false);
      }
    });

    it('audio/tts results always carry language and assetPath', () => {
      const result = selectAudioSource(POI_ID, 'pl', 'en', { pl: '/narratives/pl.md' });
      expect(result.source).toBe('tts');
      if (result.source !== 'unavailable') {
        expect(result.language).toBe('pl');
        expect(result.assetPath).toBe('/narratives/pl.md');
      }
    });
  });
});
