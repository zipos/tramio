/**
 * Unit tests for `resolveVoice` (task 8.5).
 *
 * Validates the documented fallback chain:
 *   1. exact (language, region) match
 *   2. exact language match
 *   3. platform default voice for that language
 *   4. platform default voice for the bundle's `defaultLanguage`
 *
 * Covers: Req 9.2 (TTS fallback), 9.4 (missing voice + non-fatal warning),
 * 9.5 (default-language fallback).
 */

import {
  resolveVoice,
  type ResolveVoiceInput,
  type ResolveVoiceWarning,
  type VoiceDescriptor,
} from './resolveVoice';

function voice(
  id: string,
  language: string,
  extras: Partial<Pick<VoiceDescriptor, 'region' | 'isPlatformDefault'>> = {},
): VoiceDescriptor {
  const result: VoiceDescriptor = { id, language };
  if (extras.region !== undefined) {
    Object.assign(result, { region: extras.region });
  }
  if (extras.isPlatformDefault !== undefined) {
    Object.assign(result, { isPlatformDefault: extras.isPlatformDefault });
  }
  return result;
}

function input(overrides: Partial<ResolveVoiceInput> = {}): ResolveVoiceInput {
  return {
    language: 'en',
    defaultLanguage: 'pl',
    availableVoicesForLanguage: [],
    ...overrides,
  };
}

describe('resolveVoice — step 1: exact (language, region) match', () => {
  it('returns the exact match without emitting any warning', () => {
    const target = voice('com.apple.voice.compact.en-GB.Daniel', 'en', { region: 'GB' });
    const sink: ResolveVoiceWarning[] = [];
    const result = resolveVoice(
      input({
        language: 'en',
        region: 'GB',
        availableVoicesForLanguage: [
          voice('com.apple.voice.compact.en-US.Samantha', 'en', { region: 'US' }),
          target,
        ],
      }),
      (w) => sink.push(w),
    );
    expect(result.voice).toBe(target);
    expect(result.step).toBe('exact-language-region');
    expect(sink).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('is case-insensitive on language and region tags', () => {
    const target = voice('com.apple.voice.en-GB.Daniel', 'EN', { region: 'gb' });
    const result = resolveVoice(
      input({
        language: 'en',
        region: 'GB',
        availableVoicesForLanguage: [target],
      }),
    );
    expect(result.voice).toBe(target);
    expect(result.step).toBe('exact-language-region');
  });
});

describe('resolveVoice — step 2: exact language match', () => {
  it('falls back to language-only when region does not match and emits a non-fatal warning', () => {
    const target = voice('com.apple.voice.en-US.Samantha', 'en', { region: 'US' });
    const sink: ResolveVoiceWarning[] = [];
    const result = resolveVoice(
      input({
        language: 'en',
        region: 'GB',
        availableVoicesForLanguage: [target],
      }),
      (w) => sink.push(w),
    );
    expect(result.voice).toBe(target);
    expect(result.step).toBe('exact-language');
    expect(sink).toHaveLength(1);
    expect(sink[0]?.step).toBe('exact-language-region');
    expect(sink[0]?.message).toContain('language=en');
    expect(sink[0]?.message).toContain('region=GB');
  });

  it('prefers the platform-default voice among multiple language matches', () => {
    const fallback = voice('com.apple.voice.en-US.Samantha', 'en', { region: 'US' });
    const platformDefault = voice('com.apple.voice.en.default', 'en', {
      isPlatformDefault: true,
    });
    const result = resolveVoice(
      input({
        language: 'en',
        availableVoicesForLanguage: [fallback, platformDefault],
      }),
    );
    expect(result.voice).toBe(platformDefault);
    expect(result.step).toBe('exact-language');
  });

  it('does not emit a step-1 warning when no region was requested', () => {
    const target = voice('com.apple.voice.en.default', 'en');
    const sink: ResolveVoiceWarning[] = [];
    const result = resolveVoice(
      input({
        language: 'en',
        availableVoicesForLanguage: [target],
      }),
      (w) => sink.push(w),
    );
    expect(result.voice).toBe(target);
    expect(result.step).toBe('exact-language');
    expect(sink).toHaveLength(0);
  });
});

describe('resolveVoice — step 3: platform default voice for language', () => {
  it('falls through to the platform default for the requested language', () => {
    const platformDefault = voice('platform.default.en', 'en');
    const sink: ResolveVoiceWarning[] = [];
    const result = resolveVoice(
      input({
        language: 'en',
        region: 'GB',
        availableVoicesForLanguage: [],
        platformDefaultForLanguage: platformDefault,
      }),
      (w) => sink.push(w),
    );
    expect(result.voice).toBe(platformDefault);
    expect(result.step).toBe('platform-default-language');
    // Step 1 (language+region) and step 2 (language-only) both missed and
    // each emits its own non-fatal warning.
    expect(sink.map((w) => w.step)).toEqual(['exact-language-region', 'exact-language']);
  });
});

describe('resolveVoice — step 4: platform default for bundle default language', () => {
  it('falls back to the bundle default language when the requested language has no voice anywhere', () => {
    const bundleDefault = voice('platform.default.pl', 'pl');
    const sink: ResolveVoiceWarning[] = [];
    const result = resolveVoice(
      input({
        language: 'de',
        defaultLanguage: 'pl',
        availableVoicesForLanguage: [],
        platformDefaultForLanguage: null,
        platformDefaultForDefaultLanguage: bundleDefault,
      }),
      (w) => sink.push(w),
    );
    expect(result.voice).toBe(bundleDefault);
    expect(result.step).toBe('platform-default-default-language');
    expect(sink.map((w) => w.step)).toEqual(['exact-language', 'platform-default-language']);
  });

  it('uses the available-voices list for defaultLanguage as a last resort before giving up', () => {
    const fallbackPlVoice = voice('platform.fallback.pl', 'pl');
    const result = resolveVoice(
      input({
        language: 'de',
        defaultLanguage: 'pl',
        availableVoicesForLanguage: [],
        platformDefaultForLanguage: null,
        platformDefaultForDefaultLanguage: null,
        availableVoicesForDefaultLanguage: [fallbackPlVoice],
      }),
    );
    expect(result.voice).toBe(fallbackPlVoice);
    expect(result.step).toBe('platform-default-default-language');
  });

  it('returns null with a final non-fatal warning when even the bundle default has no voice', () => {
    const sink: ResolveVoiceWarning[] = [];
    const result = resolveVoice(
      input({
        language: 'de',
        defaultLanguage: 'pl',
        availableVoicesForLanguage: [],
        platformDefaultForLanguage: null,
        platformDefaultForDefaultLanguage: null,
        availableVoicesForDefaultLanguage: [],
      }),
      (w) => sink.push(w),
    );
    expect(result.voice).toBeNull();
    expect(result.step).toBe('no-voice-available');
    expect(sink.map((w) => w.step)).toEqual([
      'exact-language',
      'platform-default-language',
      'platform-default-default-language',
    ]);
    // All warnings must be non-fatal: they are messages, not throws.
    for (const w of sink) {
      expect(typeof w.message).toBe('string');
      expect(w.message.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveVoice — warning shape', () => {
  it('records the requested language, region, and bundle defaultLanguage on every warning', () => {
    const sink: ResolveVoiceWarning[] = [];
    resolveVoice(
      input({
        language: 'fr',
        region: 'CA',
        defaultLanguage: 'pl',
        availableVoicesForLanguage: [],
        platformDefaultForLanguage: null,
        platformDefaultForDefaultLanguage: null,
      }),
      (w) => sink.push(w),
    );
    expect(sink.length).toBeGreaterThanOrEqual(3);
    for (const w of sink) {
      expect(w.language).toBe('fr');
      expect(w.region).toBe('CA');
      expect(w.defaultLanguage).toBe('pl');
    }
  });

  it('omits the region key entirely when no region was requested', () => {
    const sink: ResolveVoiceWarning[] = [];
    resolveVoice(
      input({
        language: 'fr',
        defaultLanguage: 'pl',
        availableVoicesForLanguage: [],
      }),
      (w) => sink.push(w),
    );
    expect(sink.length).toBeGreaterThan(0);
    for (const w of sink) {
      expect('region' in w).toBe(false);
    }
  });
});
