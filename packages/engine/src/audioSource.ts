// Audio source selection for POI triggers.
//
// Implements the pre-rendered / TTS / default-language fallback chain
// described in design.md "Audio source selection follows pre-rendered
// availability and language fallback" (Property 9).
//
// @see design.md "Components and Interfaces > Tour_Engine"
// @see Requirement 1.1 (audio dispatch)

/**
 * Result of audio source selection for a POI trigger.
 */
export interface AudioSourceResult {
  source: 'audio' | 'tts';
  language: string;
  /** Path to the audio file (for 'audio' source) or narrative markdown (for 'tts' source) */
  assetPath: string;
}

/**
 * Determines the audio source for a POI trigger using the fallback chain:
 *
 * 1. Pre-rendered audio in selected language
 * 2. Narrative (TTS) in selected language
 * 3. Pre-rendered audio in default language
 * 4. Narrative (TTS) in default language
 *
 * @param poiId - The POI identifier (reserved for future logging/telemetry)
 * @param selectedLanguage - User's selected language (ISO 639-1)
 * @param defaultLanguage - Bundle's default language (ISO 639-1)
 * @param narratives - POI's narratives map: { [lang]: path }
 * @param audio - POI's audio map: { [lang]: path } — may be undefined
 */
export function selectAudioSource(
  poiId: string,
  selectedLanguage: string,
  defaultLanguage: string,
  narratives: Record<string, string>,
  audio?: Record<string, string>,
): AudioSourceResult {
  // 1. Pre-rendered audio in selected language
  if (audio?.[selectedLanguage]) {
    return { source: 'audio', language: selectedLanguage, assetPath: audio[selectedLanguage] };
  }

  // 2. Narrative (TTS) in selected language
  if (narratives[selectedLanguage]) {
    return { source: 'tts', language: selectedLanguage, assetPath: narratives[selectedLanguage] };
  }

  // 3. Pre-rendered audio in default language
  if (audio?.[defaultLanguage]) {
    return { source: 'audio', language: defaultLanguage, assetPath: audio[defaultLanguage] };
  }

  // 4. Narrative (TTS) in default language
  return { source: 'tts', language: defaultLanguage, assetPath: narratives[defaultLanguage] ?? '' };
}
