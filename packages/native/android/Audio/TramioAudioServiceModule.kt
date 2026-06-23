// TramioAudioServiceModule.kt
//
// Android native side of the Audio_Service turbo module (task 8.4).
// Pairs with packages/native/src/audio/NativeAudioService.ts and is
// shape-compatible with the iOS implementation in
// packages/native/ios/Audio/TramioAudioService.{h,m}.
//
// Responsibilities (mirrors the iOS module so the engine command
// translator from task 13.1 is platform-agnostic):
//
//   * Sequential playback of a single ExoPlayer-backed segment.
//   * `AudioAttributes` set to USAGE_ASSISTANCE_NAVIGATION_GUIDANCE +
//     CONTENT_TYPE_SPEECH, with `setHandleAudioBecomingNoisy(true)` so
//     unplugging headphones pauses cleanly. Combined with the
//     foreground service from task 8.2 this keeps the tour audible in
//     the background (Req 12.1).
//   * `AudioFocusRequest` (API 26+) with AUDIOFOCUS_GAIN. Loss and
//     transient-loss are translated into `onFocusLoss` events that
//     carry the captured playback offset (Req 10.1). Gain is
//     translated into `onFocusRegain` (Req 10.2). LOSS_TRANSIENT_CAN_DUCK
//     is translated into `onDuckingChange { percent: 50 }` and the
//     player's volume is attenuated by >= 50% (Req 10.4).
//   * LUFS normalization knob: a per-segment `gainOffsetDb` (clamped
//     to ±12 dB) is converted to a linear scalar and applied to
//     `Player.volume`. Real loudness measurement is out of MVP scope;
//     the catalog owns the ~ -16 LUFS ±3 dB tolerance band (Req 9.3).
//   * Ducking via `Player.volume`: a `duck(percent)` of >= 50 satisfies
//     Req 10.4.
//   * Foreground-service coordination: on `play(...)` we ask the
//     foreground service from task 8.2 to post / keep its sticky
//     notification; on `stop(...)` we let the engine drive
//     notification teardown (it owns the location side too).
//
// The TS spec exposes addXxxListener / removeListener returning string
// tokens. RCTDeviceEventEmitter does not natively model per-call
// tokens, so the JS wrapper uses our generated token strings only as
// a handle to pair `on`/`off` calls. The native side fans out via
// DeviceEventEmitter.emit, and `removeListener` is a no-op here
// because the JS subscription lives on the JS side.

package app.tramio.client.audio

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes as PlatformAudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

class TramioAudioServiceModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    /** ExoPlayer instance for the currently-active segment, or `null` while idle. */
    private var player: ExoPlayer? = null

    /** JS-side `segmentId` for the active segment. `null` while idle. */
    private var currentSegmentId: String? = null

    /** Most recent per-segment gain offset in dB applied to the player. */
    private var currentGainOffsetDb: Double = 0.0

    /** Most recent ducking level in [0, 100]. 0 means full nominal volume. */
    private var currentDuckPercent: Double = 0.0

    /** True while a duck imposed by the OS focus-change callback is active. */
    private var osDuckActive: Boolean = false

    /** Token counter for `addXxxListener` return values. */
    private val tokenCounter = AtomicLong(0)

    /** Cached AudioManager. */
    private val audioManager: AudioManager
        get() = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    /** Active focus request (API 26+). Null while we don't hold focus. */
    private var focusRequest: AudioFocusRequest? = null

    /** Listener attached when `focusRequest` is built. Holds focus-change callbacks. */
    private val focusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        // Focus-change callbacks arrive on a binder thread; ExoPlayer
        // requires its mutating calls on the application main thread.
        mainHandler.post { handleFocusChange(focusChange) }
    }

    /** Main-thread handler so we can route focus callbacks safely. */
    private val mainHandler = Handler(Looper.getMainLooper())

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = MODULE_NAME

    // -- LifecycleEventListener ---------------------------------------

    override fun onHostResume() = Unit

    override fun onHostPause() = Unit

    override fun onHostDestroy() {
        // Ensure we don't leak the ExoPlayer or the focus request when
        // the React host tears down (e.g. the user kills the app from
        // the recents screen).
        mainHandler.post { stopInternal() }
    }

    // -- Spec methods (called via @ReactMethod) -----------------------

    /**
     * `play(segmentId, sourceJson, optsJson) -> Promise<void>`
     *
     * Stops any prior segment to honor the `|playing| <= 1` invariant
     * (Req 1.3), constructs a new ExoPlayer with the requested URL or
     * a synthetic-error path for a not-yet-resolved DecryptStreamHandle,
     * applies `gainOffsetDb` + `initialDuckPercent`, requests audio
     * focus, and starts playback.
     */
    @ReactMethod
    fun play(segmentId: String, sourceJson: String, optsJson: String, promise: Promise) {
        val source = parseJsonObject(sourceJson)
        if (source == null) {
            promise.reject(E_AUDIO_SOURCE, "Invalid sourceJson")
            return
        }
        val opts = parseJsonObject(optsJson)
        if (opts == null) {
            promise.reject(E_AUDIO_OPTS, "Invalid optsJson")
            return
        }

        val url = resolveSourceUrl(source)
        if (url == null) {
            // No URL means the source is a stream handle and the
            // streaming-decrypt resolver isn't installed yet
            // (task 13.1). Surface a synthetic
            // PlaybackFinished{error} so the engine can advance.
            emitPlaybackFinished(
                segmentId = segmentId,
                reason = "error",
                errorMessage = "DecryptStreamHandle resolver not yet wired (task 13.1)",
            )
            promise.resolve(null)
            return
        }

        val startOffsetMs = optDouble(opts, "startOffsetMs", 0.0)
        val gainOffsetDb = clamp(
            optDouble(opts, "gainOffsetDb", 0.0),
            GAIN_OFFSET_DB_MIN,
            GAIN_OFFSET_DB_MAX,
        )
        val duckPercent = clamp(
            optDouble(opts, "initialDuckPercent", 0.0),
            DUCK_PERCENT_MIN,
            DUCK_PERCENT_MAX,
        )

        mainHandler.post {
            // Tear down any prior segment before constructing a new one
            // so single-segment is preserved even under back-to-back
            // play() calls.
            releasePlayerInternal()

            val newPlayer = ExoPlayer.Builder(reactContext.applicationContext)
                .setHandleAudioBecomingNoisy(true)
                .build()
                .apply {
                    setAudioAttributes(GUIDANCE_ATTRIBUTES, /* handleAudioFocus = */ false)
                    addListener(playerListener(segmentId))
                    setMediaItem(MediaItem.fromUri(url))
                    if (startOffsetMs > 0.0) {
                        seekTo(startOffsetMs.toLong())
                    }
                    prepare()
                }

            player = newPlayer
            currentSegmentId = segmentId
            currentGainOffsetDb = gainOffsetDb
            currentDuckPercent = duckPercent
            osDuckActive = false
            applyVolume()

            val focusGranted = requestAudioFocus()
            // Tell the foreground service from task 8.2 we want to
            // be kept alive in the background (Req 12.1). The service
            // owns the sticky notification text + media-style content;
            // this is a fire-and-forget signal.
            startForegroundServiceCompat(playing = true)

            if (focusGranted) {
                newPlayer.playWhenReady = true
            } else {
                // Audio policy denied focus. We still posted a
                // synthetic finished event so the engine doesn't
                // hang, but we tear down to be safe.
                emitPlaybackFinished(
                    segmentId = segmentId,
                    reason = "error",
                    errorMessage = "Audio focus denied",
                )
                releasePlayerInternal()
            }
            promise.resolve(null)
        }
    }

    /**
     * `pause() -> Promise<number>` — captured offset in ms.
     *
     * Idempotent: if no segment is playing, resolves with 0.
     */
    @ReactMethod
    fun pause(promise: Promise) {
        mainHandler.post {
            val p = player
            if (p == null) {
                promise.resolve(0.0)
                return@post
            }
            val offsetMs = max(0L, p.currentPosition)
            p.playWhenReady = false
            promise.resolve(offsetMs.toDouble())
        }
    }

    /**
     * `resume(offsetMs) -> Promise<void>`. Idempotent if nothing paused.
     */
    @ReactMethod
    fun resume(offsetMs: Double, promise: Promise) {
        mainHandler.post {
            val p = player
            if (p == null) {
                // Idempotent: nothing to resume.
                promise.resolve(null)
                return@post
            }
            val clean = max(0L, offsetMs.toLong())
            p.seekTo(clean)
            p.playWhenReady = true
            promise.resolve(null)
        }
    }

    /** `stop() -> Promise<void>`. Idempotent. */
    @ReactMethod
    fun stop(promise: Promise) {
        mainHandler.post {
            stopInternal()
            promise.resolve(null)
        }
    }

    /** `duck(percent) -> Promise<void>`. */
    @ReactMethod
    fun duck(percent: Double, promise: Promise) {
        val clean = clamp(percent, DUCK_PERCENT_MIN, DUCK_PERCENT_MAX)
        mainHandler.post {
            currentDuckPercent = clean
            applyVolume()
            emitDuckingChange(clean)
            promise.resolve(null)
        }
    }

    // -- Listener token bridge ----------------------------------------

    @ReactMethod
    fun addPlaybackFinishedListener(callback: Callback) {
        callback.invoke(issueToken("PlaybackFinished"))
    }

    @ReactMethod
    fun addFocusLossListener(callback: Callback) {
        callback.invoke(issueToken("FocusLoss"))
    }

    @ReactMethod
    fun addFocusRegainListener(callback: Callback) {
        callback.invoke(issueToken("FocusRegain"))
    }

    @ReactMethod
    fun addDuckingChangeListener(callback: Callback) {
        callback.invoke(issueToken("DuckingChange"))
    }

    @ReactMethod
    fun removeListener(@Suppress("UNUSED_PARAMETER") token: String) {
        // Tokens are tracked on the JS side; nothing to free here.
    }

    /**
     * Required no-op pair for `RCTEventEmitter`-style codegen on the JS
     * side. The legacy bridge ignores these but the new architecture
     * codegen warns if they're missing.
     */
    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) = Unit

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) = Unit

    // -- Internals ----------------------------------------------------

    private fun playerListener(segmentId: String): Player.Listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) {
                // Native player reached end of stream.
                emitPlaybackFinished(segmentId = segmentId, reason = "completed")
                // Don't tear down focus here: the JS engine will
                // dispatch the next segment which calls play()
                // again, and rapid focus toggling preempts other
                // apps. We release the player itself.
                player?.release()
                player = null
                if (currentSegmentId == segmentId) currentSegmentId = null
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            emitPlaybackFinished(
                segmentId = segmentId,
                reason = "error",
                errorMessage = error.localizedMessage ?: "playback error",
            )
            player?.release()
            player = null
            if (currentSegmentId == segmentId) currentSegmentId = null
        }
    }

    private fun stopInternal() {
        releasePlayerInternal()
        abandonAudioFocus()
        // Ask the foreground service to drop its sticky notification.
        // Coordination only: the service is also driven by the
        // location side (task 8.2), so the service decides when to
        // actually `stopForeground`.
        startForegroundServiceCompat(playing = false)
    }

    private fun releasePlayerInternal() {
        player?.let {
            it.playWhenReady = false
            it.release()
        }
        player = null
        currentSegmentId = null
        osDuckActive = false
    }

    private fun applyVolume() {
        val p = player ?: return
        // Convert the dB offset to a linear scalar: 10 ** (dB / 20).
        // Then attenuate by the maximum of (caller-driven duck, OS-
        // imposed duck). The OS duck is a fixed >= 50% per Req 10.4.
        val gainScalar = 10.0.pow(currentGainOffsetDb / 20.0)
        val callerDuck = currentDuckPercent
        val osDuckPercent = if (osDuckActive) OS_DUCK_PERCENT else 0.0
        val effectiveDuck = max(callerDuck, osDuckPercent)
        val duckScalar = max(0.0, 1.0 - (effectiveDuck / 100.0))
        var finalVolume = gainScalar * duckScalar
        if (finalVolume > 1.0) finalVolume = 1.0
        if (finalVolume < 0.0) finalVolume = 0.0
        p.volume = finalVolume.toFloat()
    }

    private fun handleFocusChange(focusChange: Int) {
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // Pause and capture the offset (Req 10.1). The JS engine
                // reads the captured offset and drives `resume(offsetMs)`
                // on focus regain — that path runs through the reducer
                // so the 10-minute discard rule (Req 10.3) and
                // entitlement gating both apply.
                val p = player
                val capturedOffsetMs = if (p != null) max(0L, p.currentPosition) else 0L
                p?.playWhenReady = false
                emitFocusLoss(capturedOffsetMs)
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // Lower output volume by >= 50% for the duration of the
                // ducking event (Req 10.4). We don't pause; the OS
                // expects the app to keep playing at a reduced level.
                osDuckActive = true
                applyVolume()
                emitDuckingChange(OS_DUCK_PERCENT)
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (osDuckActive) {
                    osDuckActive = false
                    applyVolume()
                    emitDuckingChange(currentDuckPercent)
                }
                emitFocusRegain()
            }
        }
    }

    private fun requestAudioFocus(): Boolean {
        // API 26+ AudioFocusRequest path. minSdkVersion in the
        // app.config.ts build properties is 26, so we don't need a
        // legacy `requestAudioFocus(listener, stream, hint)` branch.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Should never happen at runtime given minSdk = 26, but
            // keep the legacy path for defense in depth.
            @Suppress("DEPRECATION")
            val legacy = audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN,
            )
            return legacy == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
        val attrs = PlatformAudioAttributes.Builder()
            .setUsage(PlatformAudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(PlatformAudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setAcceptsDelayedFocusGain(false)
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener(focusListener, mainHandler)
            .build()
        focusRequest = request
        val result = audioManager.requestAudioFocus(request)
        return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    private fun abandonAudioFocus() {
        val request = focusRequest ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.abandonAudioFocusRequest(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(focusListener)
        }
        focusRequest = null
    }

    /**
     * Coordinates with the foreground service from task 8.2.
     *
     * The service component is registered by the
     * `withTramioForegroundService` config plugin (see
     * `plugins/withTramioForegroundService.js`) with both `location`
     * and `mediaPlayback` foreground-service types. It accepts two
     * intent extras — `audioPlaying = true|false` — that this module
     * sends on `play` and `stop` so the service knows whether audio is
     * driving the foreground state.
     *
     * The service implementation itself lives next to the location
     * module from task 8.2 and is intentionally not part of this file.
     * If it isn't on the classpath yet (e.g. running these sources in
     * isolation during development) we silently swallow the
     * `ClassNotFoundException` so the module still loads.
     */
    private fun startForegroundServiceCompat(playing: Boolean) {
        val ctx = reactContext.applicationContext
        try {
            val cls = Class.forName(FOREGROUND_SERVICE_CLASS_NAME)
            val intent = Intent(ctx, cls).apply {
                action = if (playing) ACTION_AUDIO_PLAYING else ACTION_AUDIO_STOPPED
                putExtra(EXTRA_AUDIO_PLAYING, playing)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        } catch (_: ClassNotFoundException) {
            // Foreground service from task 8.2 not yet on the classpath.
            // Audio still plays; background longevity is best-effort
            // until that task lands.
        } catch (_: SecurityException) {
            // Some OEM ROMs reject startForegroundService while the app
            // is in the background without the proper permission
            // (FOREGROUND_SERVICE_*). The permission is declared in
            // app.config.ts — log via stderr and continue.
        }
    }

    private fun resolveSourceUrl(source: JSONObject): Uri? {
        val kind = source.optString("kind", "")
        if (kind == "url") {
            val urlString = source.optString("url", "")
            if (urlString.isEmpty()) return null
            return runCatching { Uri.parse(urlString) }.getOrNull()
        }
        // The streaming-decrypt resolver is wired in task 13.1.
        return null
    }

    private fun parseJsonObject(json: String): JSONObject? {
        if (json.isEmpty()) return null
        return try {
            JSONObject(json)
        } catch (_: JSONException) {
            null
        }
    }

    private fun optDouble(obj: JSONObject, key: String, fallback: Double): Double {
        val v = obj.opt(key) ?: return fallback
        return when (v) {
            is Number -> v.toDouble()
            else -> fallback
        }
    }

    private fun clamp(v: Double, lo: Double, hi: Double): Double {
        if (v.isNaN()) return lo
        if (v < lo) return lo
        if (v > hi) return hi
        return v
    }

    private fun issueToken(kind: String): String {
        val n = tokenCounter.incrementAndGet()
        return "native-$kind-$n"
    }

    // -- Event emission -----------------------------------------------

    private fun emitPlaybackFinished(
        segmentId: String,
        reason: String,
        errorMessage: String? = null,
    ) {
        val body: WritableMap = Arguments.createMap().apply {
            putString("segmentId", segmentId)
            putString("reason", reason)
            if (errorMessage != null) putString("errorMessage", errorMessage)
        }
        emit(EVENT_PLAYBACK_FINISHED, body)
    }

    private fun emitFocusLoss(capturedOffsetMs: Long) {
        val body: WritableMap = Arguments.createMap().apply {
            putDouble("capturedOffsetMs", capturedOffsetMs.toDouble())
            currentSegmentId?.let { putString("segmentId", it) }
        }
        emit(EVENT_FOCUS_LOSS, body)
    }

    private fun emitFocusRegain() {
        val body: WritableMap = Arguments.createMap().apply {
            currentSegmentId?.let { putString("segmentId", it) }
        }
        emit(EVENT_FOCUS_REGAIN, body)
    }

    private fun emitDuckingChange(percent: Double) {
        val body: WritableMap = Arguments.createMap().apply {
            putDouble("percent", percent)
        }
        emit(EVENT_DUCKING_CHANGE, body)
    }

    private fun emit(name: String, body: WritableMap) {
        // `RCTDeviceEventEmitter` is what `RCTEventEmitter` writes to
        // on the JS side; the JS wrapper subscribes via the matching
        // event names declared in
        // packages/native/src/audio/types.ts.
        if (!reactContext.hasActiveReactInstance()) return
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, body)
    }

    // -- Companion: constants -----------------------------------------

    companion object {
        /** JS-visible module name. Must match `MODULE_NAME` in iOS. */
        const val MODULE_NAME = "TramioAudioService"

        // Event names — mirror packages/native/src/audio/types.ts and
        // the iOS module's `kTramioAudioEvent...` constants.
        private const val EVENT_PLAYBACK_FINISHED = "onPlaybackFinished"
        private const val EVENT_FOCUS_LOSS = "onFocusLoss"
        private const val EVENT_FOCUS_REGAIN = "onFocusRegain"
        private const val EVENT_DUCKING_CHANGE = "onDuckingChange"

        // Promise rejection codes.
        private const val E_AUDIO_SOURCE = "E_AUDIO_SOURCE"
        private const val E_AUDIO_OPTS = "E_AUDIO_OPTS"

        // LUFS knob bounds. Mirror GAIN_OFFSET_DB_{MIN,MAX} in
        // packages/native/src/audio/NativeAudioService.ts.
        private const val GAIN_OFFSET_DB_MIN: Double = -12.0
        private const val GAIN_OFFSET_DB_MAX: Double = 12.0

        // Duck percent bounds. Mirror DUCK_PERCENT_{MIN,MAX} in TS.
        private const val DUCK_PERCENT_MIN: Double = 0.0
        private const val DUCK_PERCENT_MAX: Double = 100.0

        /**
         * OS-imposed transient duck level. Req 10.4 mandates "at least
         * 50%"; we apply exactly 50% to match the JS-side
         * `DUCK_ACTIVE_THRESHOLD_PERCENT` constant.
         */
        private const val OS_DUCK_PERCENT: Double = 50.0

        /**
         * Fully-qualified class name of the foreground service from
         * task 8.2. We resolve it reflectively so this module can
         * compile and ship before task 8.2 lands.
         */
        private const val FOREGROUND_SERVICE_CLASS_NAME =
            "app.tramio.client.location.TramioTourForegroundService"

        // Action / extra contract shared with the foreground service.
        private const val ACTION_AUDIO_PLAYING = "app.tramio.client.action.AUDIO_PLAYING"
        private const val ACTION_AUDIO_STOPPED = "app.tramio.client.action.AUDIO_STOPPED"
        private const val EXTRA_AUDIO_PLAYING = "audioPlaying"

        /**
         * media3 `AudioAttributes` shared by every player instance.
         * USAGE_ASSISTANCE_NAVIGATION_GUIDANCE + CONTENT_TYPE_SPEECH
         * tells Android's audio policy to treat us as guidance audio,
         * which (paired with the foreground service) keeps us audible
         * over notifications and short transient sounds (Req 12.1).
         */
        private val GUIDANCE_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build()
    }
}
