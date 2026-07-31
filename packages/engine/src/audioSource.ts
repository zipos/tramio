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
 *
 * The discriminated `source` field tells the caller how to handle the result:
 * - 'audio': pre-rendered audio file at `assetPath`
 * - 'tts': narrative markdown at `assetPath`, to be spoken by the TTS engine
 * - 'unavailable': no content exists for this POI; the caller should skip it
 *
 * FIX 5: Added 'unavailable' variant so callers can distinguish "no content"
 * from "empty path". Previously the function returned `assetPath: ''` when
 * narratives were missing, which caused silent failures or TTS engine errors.
 * @see Requirement 1.1
 */
export type AudioSourceResult =
  | { source: 'audio'; language: string; assetPath: string }
  | { source: 'tts'; language: string; assetPath: string }
  | { source: 'unavailable' };

/**
 * Determines the audio source for a POI trigger using the fallback chain:
 *
 * 1. Pre-rendered audio in selected language
 * 2. Narrative (TTS) in selected language
 * 3. Pre-rendered audio in default language
 * 4. Narrative (TTS) in default language
 * 5. Pre-rendered audio in ANY available language (prefer audio over TTS)
 * 6. Narrative (TTS) in ANY available language
 * 7. Unavailable — no content exists for this POI
 *
 * FIX 5: Extended the chain with steps 5–7. Previously the function returned
 * an empty assetPath when a POI had narratives in neither the selected nor
 * the default language (incomplete translation on a freshly authored POI).
 * Now it falls back to any available language (preferring pre-rendered audio)
 * and returns an explicit 'unavailable' result when genuinely nothing exists.
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
  if (narratives[defaultLanguage]) {
    return { source: 'tts', language: defaultLanguage, assetPath: narratives[defaultLanguage] };
  }

  // 5. Pre-rendered audio in ANY available language (prefer audio over narrative
  //    because pre-rendered audio has correct pronunciation and prosody).
  if (audio) {
    const audioLangs = Object.keys(audio);
    for (const lang of audioLangs) {
      if (audio[lang]) {
        return { source: 'audio', language: lang, assetPath: audio[lang] };
      }
    }
  }

  // 6. Narrative (TTS) in ANY available language.
  const narrativeLangs = Object.keys(narratives);
  for (const lang of narrativeLangs) {
    if (narratives[lang]) {
      return { source: 'tts', language: lang, assetPath: narratives[lang] };
    }
  }

  // 7. Genuinely nothing exists for this POI — return explicit unavailable
  //    so the caller can skip the POI instead of playing silence or erroring.
  return { source: 'unavailable' };
}
