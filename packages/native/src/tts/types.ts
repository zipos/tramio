// @tramio/native — TTS_Engine types
//
// These types are deliberately shaped to match `Audio_Service`'s playback
// events (design.md "Components and Interfaces > TTS_Engine":
// _Wraps `AVSpeechSynthesizer` (iOS) and `android.speech.tts.TextToSpeech`
// (Android). [...] Emits the same playback events as Audio_Service so the
// engine treats them uniformly._). The Tour_Engine consumes both engines
// behind one event vocabulary so task 13.1 can wire either without
// branching, and Property 9 (`Audio source selection follows pre-rendered
// availability and language fallback`) does not have to know which engine
// rendered a segment to assert correctness.
//
// Spec references:
//   - Req 9.2  (TTS fallback when no pre-rendered audio in selected lang)
//   - Req 9.4  (missing voice -> platform default + non-fatal warning)
//   - Req 15.1 (Native turbo module wrapping AVSpeechSynthesizer / Android TTS)

/** ISO 639-1 language tag, e.g. "en", "pl", "de". */
export type LanguageTag = string;

/** ISO 3166-1 alpha-2 region tag, e.g. "US", "GB", "PL". Optional. */
export type RegionTag = string;

/**
 * Options accepted by `NativeTtsEngine.speak`.
 *
 * `language` + optional `region` drive the voice resolution chain
 * documented on `resolveVoice`. `defaultLanguage` is the bundle-level
 * fallback (Req 9.5) used as the last resort by step 4 of the chain.
 *
 * `rate` follows Req 16.4 (0.75x..1.5x in 0.25 increments). Native sides
 * are responsible for clamping; this type does not enforce the discrete
 * set so the engine can remain the single source of truth.
 */
export interface SpeakOptions {
  /** Stable id used to correlate `PlaybackFinished` back to the engine. */
  readonly segmentId: string;
  /** Selected user language for this segment. */
  readonly language: LanguageTag;
  /** Optional regional preference. Falls back to language-only on miss. */
  readonly region?: RegionTag;
  /** Bundle's `defaultLanguage` (manifest.json). Used by fallback step 4. */
  readonly defaultLanguage: LanguageTag;
  /** Playback rate multiplier (e.g. 0.75, 1.0, 1.25, 1.5). Optional. */
  readonly rate?: number;
  /** Pitch multiplier. Optional. Native sides apply platform clamping. */
  readonly pitch?: number;
  /**
   * Output volume in [0, 1]. Optional. Audio_Service is responsible for
   * the LUFS normalization layer (Req 9.3); this is a per-utterance hint.
   */
  readonly volume?: number;
}

/**
 * Playback events emitted by `NativeTtsEngine`. The shapes here mirror
 * `EngineEvent`'s `AudioFinished` / `FocusLoss` / `FocusRegain` from
 * design.md "Runtime types" so the engine's command translator can fan
 * either Audio_Service or TTS_Engine events into the reducer without
 * branching.
 *
 * Concretely, on the iOS side the AVSpeechSynthesizerDelegate callback
 * `speechSynthesizer:didFinishSpeechUtterance:` produces a
 * `PlaybackFinished`, and the `AVAudioSession` interruption notifications
 * (the same notifications Audio_Service hooks) produce `FocusLoss` /
 * `FocusRegain`.
 */
export type TtsPlaybackEvent =
  | { readonly kind: 'PlaybackFinished'; readonly segmentId: string }
  | { readonly kind: 'FocusLoss' }
  | { readonly kind: 'FocusRegain' };

export type TtsPlaybackListener = (event: TtsPlaybackEvent) => void;

export type PlaybackFinishedListener = (event: { readonly segmentId: string }) => void;
export type FocusLossListener = () => void;
export type FocusRegainListener = () => void;

/** Subscription handle. Calling the returned function detaches the listener. */
export type Unsubscribe = () => void;

/**
 * Native binding contract. The iOS `TramioTtsEngine` (Obj-C) and the
 * eventual Android `TramioTtsEngine` (Kotlin) implement this surface; the
 * JS-side `NativeTtsEngine` wraps it. Tests in this package use a fake
 * binding so the wrapper is exercised without a native runtime.
 */
export interface NativeTtsEngineBinding {
  speak(text: string, opts: SpeakOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Subscribe to the unified TTS playback event stream. The returned
   * function unsubscribes that listener.
   */
  addPlaybackListener(listener: TtsPlaybackListener): Unsubscribe;
}
