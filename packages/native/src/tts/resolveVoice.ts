// @tramio/native — TTS_Engine voice resolution
//
// Documented fallback chain (per task 8.5):
//
//   1. Exact `(language, region)` match.
//   2. Exact `language` match (any region).
//   3. Platform default voice for that language.
//   4. Platform default voice for `defaultLanguage` (the bundle's
//      manifest.defaultLanguage, Req 9.5).
//
// Each fallback step logs a non-fatal warning at the boundary so misses
// are visible in operator telemetry without crashing playback (Req 9.4).
// Step 4 succeeds vacuously: the platform default voice for the bundle's
// declared default language always exists; if it does not, the resolver
// returns `null` and the caller is expected to surface a non-fatal
// warning and fall through to the platform's "any voice" path.
//
// Spec references: Req 9.2, 9.4, 9.5, 15.1.

import type { LanguageTag, RegionTag } from './types';

/**
 * A voice descriptor as exposed by either platform.
 *
 * `id` is the platform-specific identifier:
 *   - iOS: `AVSpeechSynthesisVoice.identifier`
 *   - Android: the `android.speech.tts.Voice.getName()` string
 *
 * `language` is normalized to an ISO 639-1 lower-case tag.
 * `region` is the optional ISO 3166-1 alpha-2 upper-case tag if the
 * platform reports one.
 */
export interface VoiceDescriptor {
  readonly id: string;
  readonly language: LanguageTag;
  readonly region?: RegionTag;
  /**
   * True when the platform considers this the default voice for its
   * language (e.g. iOS `AVSpeechSynthesisVoice.speechVoice(forLanguage:)`
   * returns this, or Android `TextToSpeech.getDefaultVoice()` matches it).
   */
  readonly isPlatformDefault?: boolean;
}

/** Reason field on resolution failure / fallback log entries. */
export type ResolveStep =
  | 'exact-language-region'
  | 'exact-language'
  | 'platform-default-language'
  | 'platform-default-default-language';

export interface ResolveVoiceWarning {
  /** Which step in the fallback chain emitted the warning. */
  readonly step: ResolveStep;
  /** Requested language for the lookup that produced this warning. */
  readonly language: LanguageTag;
  /** Requested region, if any. */
  readonly region?: RegionTag;
  /** Bundle default language (manifest.defaultLanguage). */
  readonly defaultLanguage: LanguageTag;
  /** Human-readable summary suitable for `os_log` / `Log.w`. */
  readonly message: string;
}

export interface ResolveVoiceResult {
  /**
   * The chosen voice. `null` means even step 4 produced no candidate; the
   * native side should fall through to the platform's "any voice" path
   * and treat the segment as best-effort.
   */
  readonly voice: VoiceDescriptor | null;
  /** Which step actually succeeded. */
  readonly step: ResolveStep | 'no-voice-available';
  /** Ordered list of fallback steps that emitted a warning before success. */
  readonly warnings: readonly ResolveVoiceWarning[];
}

export interface ResolveVoiceInput {
  readonly language: LanguageTag;
  readonly region?: RegionTag;
  readonly defaultLanguage: LanguageTag;
  /**
   * Result of `AVSpeechSynthesisVoice.voices(forLanguage:)` (or the
   * Android equivalent) for the requested `language`. Caller normalizes
   * tags to lower-case.
   */
  readonly availableVoicesForLanguage: ReadonlyArray<VoiceDescriptor>;
  /**
   * Result of `AVSpeechSynthesisVoice.voices(forLanguage:)` (or the
   * Android equivalent) for the bundle's `defaultLanguage`.
   *
   * Optional because on the hot path the caller typically only fetches
   * the bundle default's voices when the requested language has none.
   * Defaults to `[]`.
   */
  readonly availableVoicesForDefaultLanguage?: ReadonlyArray<VoiceDescriptor>;
  /**
   * `AVSpeechSynthesisVoice.speechVoice(forLanguage:)` for the requested
   * `language`, or null if the platform did not return one. This is the
   * documented step 3 fallback target on iOS.
   */
  readonly platformDefaultForLanguage?: VoiceDescriptor | null;
  /**
   * Same as above but for the bundle's `defaultLanguage`. Step 4.
   */
  readonly platformDefaultForDefaultLanguage?: VoiceDescriptor | null;
}

/** Receiver for non-fatal warnings emitted at each fallback boundary. */
export type WarningSink = (warning: ResolveVoiceWarning) => void;

/** No-op sink used when the caller does not care about warnings. */
export const noopWarningSink: WarningSink = () => {
  // intentionally empty
};

function normalizeLang(tag: LanguageTag): string {
  return tag.trim().toLowerCase();
}

function normalizeRegion(tag: RegionTag | undefined): string | undefined {
  if (tag === undefined) return undefined;
  const trimmed = tag.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function matchExactLanguageRegion(
  voices: ReadonlyArray<VoiceDescriptor>,
  language: string,
  region: string | undefined,
): VoiceDescriptor | null {
  if (region === undefined) return null;
  for (const v of voices) {
    if (normalizeLang(v.language) === language && normalizeRegion(v.region) === region) {
      return v;
    }
  }
  return null;
}

function matchExactLanguage(
  voices: ReadonlyArray<VoiceDescriptor>,
  language: string,
): VoiceDescriptor | null {
  // Prefer a voice the platform marks as the language default if multiple
  // match; otherwise the first one.
  let firstMatch: VoiceDescriptor | null = null;
  for (const v of voices) {
    if (normalizeLang(v.language) !== language) continue;
    if (v.isPlatformDefault === true) return v;
    if (firstMatch === null) firstMatch = v;
  }
  return firstMatch;
}

/**
 * Resolve the voice the native TTS engine should use for an utterance,
 * walking the documented fallback chain. Each fallback step logs a
 * non-fatal warning so misses are observable.
 */
export function resolveVoice(input: ResolveVoiceInput, sink: WarningSink = noopWarningSink): ResolveVoiceResult {
  const language = normalizeLang(input.language);
  const region = normalizeRegion(input.region);
  const defaultLanguage = normalizeLang(input.defaultLanguage);
  const warnings: ResolveVoiceWarning[] = [];

  const emit = (w: ResolveVoiceWarning): void => {
    warnings.push(w);
    sink(w);
  };

  // Step 1: exact (language, region).
  if (region !== undefined) {
    const v = matchExactLanguageRegion(input.availableVoicesForLanguage, language, region);
    if (v) {
      return { voice: v, step: 'exact-language-region', warnings };
    }
    emit({
      step: 'exact-language-region',
      language,
      region,
      defaultLanguage,
      message: `TTS_Engine: no voice matched (language=${language}, region=${region}); falling back to language-only match`,
    });
  }

  // Step 2: exact language match (any region).
  {
    const v = matchExactLanguage(input.availableVoicesForLanguage, language);
    if (v) {
      return { voice: v, step: 'exact-language', warnings };
    }
    emit({
      step: 'exact-language',
      language,
      ...(region !== undefined ? { region } : {}),
      defaultLanguage,
      message: `TTS_Engine: no voice matched language=${language}; falling back to platform default for language`,
    });
  }

  // Step 3: platform default voice for the requested language.
  {
    const v = input.platformDefaultForLanguage ?? null;
    if (v) {
      return { voice: v, step: 'platform-default-language', warnings };
    }
    emit({
      step: 'platform-default-language',
      language,
      ...(region !== undefined ? { region } : {}),
      defaultLanguage,
      message: `TTS_Engine: no platform default for language=${language}; falling back to platform default for defaultLanguage=${defaultLanguage}`,
    });
  }

  // Step 4: platform default voice for the bundle's defaultLanguage.
  {
    const v = input.platformDefaultForDefaultLanguage ?? null;
    if (v) {
      return { voice: v, step: 'platform-default-default-language', warnings };
    }
    // Last resort: try any voice listed under the bundle default lang.
    const anyDefault = matchExactLanguage(
      input.availableVoicesForDefaultLanguage ?? [],
      defaultLanguage,
    );
    if (anyDefault) {
      return { voice: anyDefault, step: 'platform-default-default-language', warnings };
    }
    emit({
      step: 'platform-default-default-language',
      language,
      ...(region !== undefined ? { region } : {}),
      defaultLanguage,
      message: `TTS_Engine: no voice available for defaultLanguage=${defaultLanguage}; native side should fall through to any-voice path`,
    });
  }

  return { voice: null, step: 'no-voice-available', warnings };
}
