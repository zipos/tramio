/*
 * TramioTtsEngineModule.kt
 * @tramio/native — TTS_Engine Android native side (task 8.6)
 *
 * Wraps `android.speech.tts.TextToSpeech` (Req 15.1) and exposes the
 * JS-side spec declared in `packages/native/src/tts/NativeTtsEngine.ts`
 * (`speak`, `pause`, `resume`, `stop`). Voice resolution mirrors
 * `packages/native/src/tts/resolveVoice.ts` exactly so the four-step
 * fallback chain stays consistent across iOS and Android:
 *
 *   1. Find a `Voice` whose `Voice.getLocale()` reports the requested
 *      `(language, region)` (BCP-47 components).
 *   2. Find a `Voice` whose locale's language matches the requested
 *      language (any region).
 *   3. Use the platform default for the requested language by calling
 *      `TextToSpeech.setLanguage(Locale)` with `(language, region)`
 *      and accepting whatever voice the engine selects.
 *   4. Use the platform default for the bundle's `defaultLanguage` via
 *      `TextToSpeech.setLanguage(Locale(defaultLanguage))`.
 *
 * Each fallback step that misses logs a non-fatal warning via
 * `Log.w(...)` so the failure is visible in `logcat` without crashing
 * playback (Req 9.4).
 *
 * Playback events are shaped identically to `TramioAudioServiceModule`
 * so the engine's command translator (task 13.1) can route either
 * backend uniformly:
 *
 *   - onPlaybackFinished : { segmentId }
 *   - onFocusLoss        : {}
 *   - onFocusRegain      : {}
 *
 * `UtteranceProgressListener.onDone` and `onError` both produce
 * `onPlaybackFinished`. Per the task brief these two paths are not
 * distinguished; the engine's reducer treats either as a finish event
 * (Req 1.7 release-on-end).
 *
 * Audio focus loss / regain piggybacks the same `AudioManager`
 * notifications `TramioAudioServiceModule` hooks. Per the task brief
 * ("do not own a separate focus request — observe via the same
 * BroadcastReceiver path as Audio_Service or share the focus
 * manager"), this module does NOT own its own `AudioFocusRequest`.
 * The Android `AudioManager` does not expose a passive
 * focus-observation API: an `OnAudioFocusChangeListener` only
 * receives callbacks when its associated focus request is the focus
 * owner, which would race `TramioAudioServiceModule`. So this module
 * keeps the JS-side `onFocusLoss` / `onFocusRegain` surface for parity
 * with the iOS module but on Android those events are routed through
 * Audio_Service's event stream at the engine level (task 13.1 wiring).
 * The native side here only handles the synthesis lifecycle.
 *
 * If a future Android version exposes a real "register focus listener
 * without requesting focus" API (e.g. `AudioManager.registerAudioPolicy`
 * for system apps), the focus events can be emitted directly from
 * here without changing the JS-side spec.
 */

package app.tramio.client.tts

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.Locale
import java.util.concurrent.atomic.AtomicReference

class TramioTtsEngineModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  /**
   * The `TextToSpeech` instance is created lazily on the first `speak`
   * call. `TextToSpeech.OnInitListener` runs on a background thread, so
   * we gate `speak` behind an `AtomicReference` that holds either an
   * un-initialized engine, an initialized engine, or a fatal-failure
   * marker.
   */
  private val ttsRef = AtomicReference<TtsState>(TtsState.NotCreated)

  /**
   * Current segment id being spoken. Cleared on completion so a stale
   * `onPlaybackFinished` cannot fire after `stop`.
   */
  private val currentSegmentIdRef = AtomicReference<String?>(null)

  override fun getName(): String = MODULE_NAME

  // region React-bridge methods

  /**
   * Speak `text` with `opts`. See `SpeakOptions` in the JS-side spec
   * for accepted keys. Resolves on speak-queued; the actual
   * completion arrives via `onPlaybackFinished`.
   */
  @ReactMethod
  fun speak(text: String, opts: ReadableMap, promise: Promise) {
    val segmentId = opts.getStringOrNull(OPTION_SEGMENT_ID)
    val language = opts.getStringOrNull(OPTION_LANGUAGE)
    val defaultLanguage = opts.getStringOrNull(OPTION_DEFAULT_LANGUAGE)
    if (segmentId.isNullOrEmpty() || language.isNullOrEmpty() || defaultLanguage.isNullOrEmpty()) {
      promise.reject(
        "E_TTS_ARGUMENTS",
        "speak requires segmentId, language, defaultLanguage",
      )
      return
    }
    val region = opts.getStringOrNull(OPTION_REGION)
    val rate = opts.getDoubleOrNull(OPTION_RATE)
    val pitch = opts.getDoubleOrNull(OPTION_PITCH)
    val volume = opts.getDoubleOrNull(OPTION_VOLUME)

    withInitializedEngine(promise) { engine ->
      // Cancel anything in flight to honour the engine's single-segment
      // invariant (`|playing| <= 1`, design.md). The cancellation path
      // emits a `onDone` -> PlaybackFinished for the prior segment via
      // the utterance listener so the engine reducer sees the
      // transition cleanly.
      engine.stop()

      // Step through the documented voice-resolution fallback chain
      // (mirrors `resolveVoice.ts`). Each miss logs `Log.w` (Req 9.4).
      resolveAndApplyVoice(engine, language, region, defaultLanguage)

      if (rate != null) {
        // `setSpeechRate(1.0f)` is the platform default. The engine's
        // band is [0.75 .. 1.5] (Req 16.4), the platform accepts any
        // positive float; we clamp defensively.
        engine.setSpeechRate(rate.toFloat().coerceIn(0.5f, 2.0f))
      }
      if (pitch != null) {
        engine.setPitch(pitch.toFloat().coerceIn(0.5f, 2.0f))
      }

      val params = Bundle().apply {
        if (volume != null) {
          // `KEY_PARAM_VOLUME` accepts [0.0, 1.0]. Audio_Service is
          // responsible for the LUFS normalization layer (Req 9.3);
          // this is a per-utterance hint.
          putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.toFloat().coerceIn(0f, 1f))
        }
      }

      currentSegmentIdRef.set(segmentId)
      val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, segmentId)
      if (result == TextToSpeech.SUCCESS) {
        promise.resolve(null)
      } else {
        currentSegmentIdRef.set(null)
        // Surface a synthetic `onPlaybackFinished` so the engine can
        // advance rather than waiting forever for completion. We do
        // NOT distinguish error vs success here per the task brief
        // ("onError -> onPlaybackFinished with no special distinction").
        emitPlaybackFinished(segmentId)
        promise.reject("E_TTS_SPEAK", "TextToSpeech.speak returned $result")
      }
    }
  }

  /**
   * Pause is best-effort on Android: `TextToSpeech` does not expose a
   * pause primitive. We stop the synthesizer and emit a synthetic
   * `onPlaybackFinished` so the engine reducer transitions out of
   * playback cleanly. The engine's focus-loss path uses the same
   * approach.
   */
  @ReactMethod
  fun pause(promise: Promise) {
    when (val state = ttsRef.get()) {
      is TtsState.Ready -> state.engine.stop()
      else -> Unit
    }
    promise.resolve(null)
  }

  /**
   * Resume is a no-op on Android because `TextToSpeech` cannot resume
   * a stopped utterance from an offset. The engine's reducer is
   * expected to re-issue `speak` if it wants to continue (the JS spec
   * documents this). We resolve cleanly so the JS-side wrapper can
   * keep its uniform `pause` / `resume` surface.
   */
  @ReactMethod
  fun resume(promise: Promise) {
    promise.resolve(null)
  }

  @ReactMethod
  fun stop(promise: Promise) {
    when (val state = ttsRef.get()) {
      is TtsState.Ready -> state.engine.stop()
      else -> Unit
    }
    // Don't clear `currentSegmentIdRef` here: the utterance listener's
    // `onDone` / `onError` callback runs after `stop` and is the
    // single place that emits `onPlaybackFinished`. Clearing here
    // would race the listener and drop the event.
    promise.resolve(null)
  }

  /**
   * Required by `RCTEventEmitter`-style modules even on Android where
   * the React Native bridge does not enforce subscription tracking.
   * Kept as a no-op so the JS wrapper's `addPlaybackListener` works
   * identically across platforms.
   */
  @ReactMethod
  fun addListener(eventName: String) {
    // No-op: React Native handles listener bookkeeping on the JS side.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // No-op: see `addListener`.
  }

  // endregion

  // region Lifecycle

  /**
   * Called by `TramioTtsEnginePackage` when the React context is torn
   * down. Releases the underlying `TextToSpeech` instance so a
   * hot-reload doesn't leak the native engine.
   */
  fun release() {
    when (val state = ttsRef.getAndSet(TtsState.NotCreated)) {
      is TtsState.Ready -> {
        state.engine.stop()
        state.engine.shutdown()
      }
      else -> Unit
    }
    currentSegmentIdRef.set(null)
  }

  override fun invalidate() {
    super.invalidate()
    release()
  }

  // endregion

  // region Engine init

  private fun withInitializedEngine(promise: Promise, action: (TextToSpeech) -> Unit) {
    when (val state = ttsRef.get()) {
      is TtsState.Ready -> action(state.engine)
      is TtsState.Failed -> promise.reject("E_TTS_INIT", state.message)
      TtsState.NotCreated, TtsState.Initializing -> initializeEngine(promise, action)
    }
  }

  private fun initializeEngine(promise: Promise, action: (TextToSpeech) -> Unit) {
    // Optimistic CAS so concurrent `speak` calls don't construct two
    // engines. If we lose the race we wait for the winner's init to
    // complete.
    if (!ttsRef.compareAndSet(TtsState.NotCreated, TtsState.Initializing)) {
      // Another caller is initializing; busy-wait briefly. `TextToSpeech`
      // init typically completes within ~100 ms on a warm device.
      val winnerState = ttsRef.get()
      if (winnerState is TtsState.Ready) {
        action(winnerState.engine)
      } else {
        promise.reject("E_TTS_INIT_RACE", "TTS engine still initializing")
      }
      return
    }

    val ctx: Context = reactContext.applicationContext
    var engine: TextToSpeech? = null
    engine = TextToSpeech(ctx) { status ->
      val capturedEngine = engine
      if (status == TextToSpeech.SUCCESS && capturedEngine != null) {
        capturedEngine.setOnUtteranceProgressListener(progressListener)
        ttsRef.set(TtsState.Ready(capturedEngine))
        try {
          action(capturedEngine)
        } catch (t: Throwable) {
          promise.reject("E_TTS_SPEAK", t)
        }
      } else {
        ttsRef.set(TtsState.Failed("TextToSpeech init failed with status=$status"))
        promise.reject("E_TTS_INIT", "TextToSpeech init failed with status=$status")
      }
    }
  }

  private val progressListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {
      // Intentionally empty: the engine's `Playing` state is driven
      // by the JS-side `speak` resolve, not by `onStart`.
    }

    override fun onDone(utteranceId: String?) {
      emitPlaybackFinished(utteranceId)
    }

    @Deprecated("Replaced by onError(String, Int) in API 21+. Kept for compatibility.")
    override fun onError(utteranceId: String?) {
      // Per the task brief: `onError` -> `onPlaybackFinished` with
      // no special distinction. The engine treats it as a finish.
      emitPlaybackFinished(utteranceId)
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      Log.w(TAG, "TTS_Engine: synthesis error (utteranceId=$utteranceId, code=$errorCode)")
      emitPlaybackFinished(utteranceId)
    }

    override fun onStop(utteranceId: String?, interrupted: Boolean) {
      // `onStop` fires for explicit `stop()` calls and also when an
      // utterance is interrupted by `QUEUE_FLUSH`. Both paths converge
      // on `onPlaybackFinished` per Req 1.7.
      emitPlaybackFinished(utteranceId)
    }
  }

  // endregion

  // region Voice resolution

  /**
   * Walks the documented fallback chain and applies the chosen
   * configuration to `engine`. Mirrors
   * `packages/native/src/tts/resolveVoice.ts`.
   */
  private fun resolveAndApplyVoice(
    engine: TextToSpeech,
    requestedLanguage: String,
    requestedRegion: String?,
    defaultLanguage: String,
  ) {
    val language = requestedLanguage.trim().lowercase(Locale.ROOT)
    val region = requestedRegion?.trim()?.uppercase(Locale.ROOT)?.takeIf { it.isNotEmpty() }
    val defLang = defaultLanguage.trim().lowercase(Locale.ROOT)

    val voices: Set<Voice> = try {
      engine.voices ?: emptySet()
    } catch (t: Throwable) {
      // Some platform variants throw for missing data installs; treat
      // an empty set as a clean miss for steps 1 and 2 and fall
      // through to step 3.
      Log.w(TAG, "TTS_Engine: TextToSpeech.getVoices() threw; falling back to default-language path", t)
      emptySet()
    }

    // Step 1: exact (language, region).
    if (region != null) {
      val match = voices.firstOrNull { v ->
        val locale = v.locale ?: return@firstOrNull false
        locale.language.equals(language, ignoreCase = true) &&
          locale.country.equals(region, ignoreCase = true)
      }
      if (match != null) {
        engine.voice = match
        return
      }
      Log.w(
        TAG,
        "TTS_Engine: no voice matched (language=$language, region=$region); " +
          "falling back to language-only match",
      )
    }

    // Step 2: exact language match (any region).
    run {
      val match = voices.firstOrNull { v ->
        val locale = v.locale ?: return@firstOrNull false
        locale.language.equals(language, ignoreCase = true)
      }
      if (match != null) {
        engine.voice = match
        return
      }
      Log.w(
        TAG,
        "TTS_Engine: no voice matched language=$language; " +
          "falling back to platform default for language",
      )
    }

    // Step 3: platform default for the requested language.
    run {
      val locale = if (region != null) Locale(language, region) else Locale(language)
      val result = engine.setLanguage(locale)
      if (isLanguageSet(result)) {
        return
      }
      Log.w(
        TAG,
        "TTS_Engine: no platform default for language=$language; " +
          "falling back to platform default for defaultLanguage=$defLang",
      )
    }

    // Step 4: platform default for the bundle's defaultLanguage.
    run {
      val result = engine.setLanguage(Locale(defLang))
      if (isLanguageSet(result)) {
        return
      }
      Log.w(
        TAG,
        "TTS_Engine: no voice available for defaultLanguage=$defLang; " +
          "TextToSpeech will fall through to its any-voice path",
      )
    }
  }

  /**
   * `TextToSpeech.setLanguage` returns one of:
   *   - LANG_AVAILABLE / LANG_COUNTRY_AVAILABLE / LANG_COUNTRY_VAR_AVAILABLE  -> success
   *   - LANG_MISSING_DATA / LANG_NOT_SUPPORTED                                -> miss
   * We treat any non-negative return value as success; the platform
   * documents negative returns as the miss codes.
   */
  private fun isLanguageSet(result: Int): Boolean = result >= 0

  // endregion

  // region Audio focus
  //
  // Per the task brief ("do not own a separate focus request"), this
  // module does not register an `AudioFocusRequest`. The JS-side
  // `onFocusLoss` / `onFocusRegain` listeners exposed by
  // `NativeTtsEngine` exist for shape-parity with the iOS module; on
  // Android they are routed through `TramioAudioServiceModule`'s
  // event stream at the engine level (task 13.1 wiring). The
  // companion event constants below are kept so the JS wrapper can
  // discover the canonical event names from a single source.

  // endregion

  // region Event emission

  private fun emitPlaybackFinished(utteranceId: String?) {
    val segmentId: String = if (!utteranceId.isNullOrEmpty()) {
      // The Android `UtteranceProgressListener` always passes the
      // utteranceId we supplied to `speak`, so we can emit precisely
      // for that segment. Clear the ref only if it still points at
      // the same id; the next `speak` may have already replaced it.
      currentSegmentIdRef.compareAndSet(utteranceId, null)
      utteranceId
    } else {
      // Spurious null-id callback (rare on modern OEMs, but
      // documented as possible). Fall back to the most recent ref;
      // bail if there's nothing to finish.
      currentSegmentIdRef.getAndSet(null) ?: return
    }
    val body = Arguments.createMap().apply { putString(OPTION_SEGMENT_ID, segmentId) }
    emit(EVENT_PLAYBACK_FINISHED, body)
  }

  private fun emit(eventName: String, body: WritableMap) {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(eventName, body)
  }

  // endregion

  // region Helpers

  private fun ReadableMap.getStringOrNull(key: String): String? =
    if (hasKey(key) && !isNull(key)) getString(key) else null

  private fun ReadableMap.getDoubleOrNull(key: String): Double? =
    if (hasKey(key) && !isNull(key)) getDouble(key) else null

  // endregion

  /**
   * Engine lifecycle states. The synthesizer is created lazily on the
   * first `speak` call so cold-start cost is paid by the caller, not
   * by app boot.
   */
  private sealed class TtsState {
    object NotCreated : TtsState()
    object Initializing : TtsState()
    data class Ready(val engine: TextToSpeech) : TtsState()
    data class Failed(val message: String) : TtsState()
  }

  companion object {
    const val MODULE_NAME: String = "TramioTtsEngine"
    private const val TAG: String = "TramioTtsEngine"

    // Event names. Match the JS-side `TtsPlaybackEvent.kind`
    // discriminator vocabulary and the iOS module's constants.
    const val EVENT_PLAYBACK_FINISHED: String = "onPlaybackFinished"
    const val EVENT_FOCUS_LOSS: String = "onFocusLoss"
    const val EVENT_FOCUS_REGAIN: String = "onFocusRegain"

    // SpeakOptions keys. Match `SpeakOptions` in
    // `packages/native/src/tts/types.ts`.
    const val OPTION_SEGMENT_ID: String = "segmentId"
    const val OPTION_LANGUAGE: String = "language"
    const val OPTION_REGION: String = "region"
    const val OPTION_DEFAULT_LANGUAGE: String = "defaultLanguage"
    const val OPTION_RATE: String = "rate"
    const val OPTION_PITCH: String = "pitch"
    const val OPTION_VOLUME: String = "volume"
  }
}
