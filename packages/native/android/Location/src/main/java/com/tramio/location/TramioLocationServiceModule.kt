/*
 * TramioLocationServiceModule.kt
 * @tramio/native — Location_Service Android native side (task 8.2).
 *
 * Wraps:
 *   - `FusedLocationProviderClient` for continuous location updates,
 *     priority-controlled per the Battery and Polling Policy table in
 *     design.md.
 *   - `GeofencingClient` for DWELL+ENTER+EXIT transitions delivered via
 *     `TramioGeofenceBroadcastReceiver`.
 *   - `TramioTourForegroundService` for sticky-notification foreground
 *     execution while a tour is active (Req 12.1, 12.2).
 *
 * Surfaces the same JS-side spec declared in
 * `packages/native/src/location/NativeLocationService.ts`. Event names,
 * payload shapes, and method signatures are identical to the iOS module
 * implemented in task 8.1. Anything platform-specific is a comment, not
 * a behavioral divergence.
 *
 * The module owns three responsibilities that intentionally stay native
 * (rather than living in JS) because they need to be cheap on battery
 * and resilient to JS-thread suspension while the screen is locked
 * during a tour:
 *
 *   1. Stage 1 of the geofence pipeline: the **accuracy gate**. Every
 *      `Location` whose `accuracy` exceeds 50 m is dropped at the bridge
 *      boundary and surfaced as an `onRejected` event with
 *      `reason="accuracy"` (Req 5.1).
 *
 *   2. Stage 2 of the geofence pipeline: **spike rejection**. We compare
 *      the great-circle distance between consecutive accepted fixes and
 *      reject any update whose implied ground speed exceeds 120 km/h
 *      (33.33 m/s) (Req 5.2).
 *
 *   3. The **sliding region window**. iOS caps active region monitors at
 *      20; Android `GeofencingClient` caps at 100. We arm a window of
 *      18 nearest geofences on both platforms so authored content
 *      behaves identically across iOS and Android. Two slots are left
 *      free for transient reconciliation regions (per design.md "iOS
 *      region monitoring limited to 20 active regions" — same envelope
 *      for parity).
 *
 * Operational modes are translated by `setMode` into the
 * `FusedLocationProviderClient` configuration that satisfies the
 * design's Battery and Polling Policy table:
 *
 *   idle           : stop continuous updates; remove geofences;
 *                    stop foreground service.
 *   standby        : balanced-power continuous updates; geofences armed;
 *                    foreground service running.
 *   tour-bg        : balanced-power continuous updates; geofences armed;
 *                    foreground service running.
 *   tour-approach  : high-accuracy continuous updates; geofences armed;
 *                    foreground service running.
 *   reconcile      : high-accuracy continuous updates; geofences armed;
 *                    foreground service running. Distinguished from
 *                    `tour-approach` only at the engine layer.
 *
 * The user-visible high-accuracy indicator (Req 11.5) is driven by
 * `onAccuracyChanged` which fires whenever the module enters/leaves
 * `tour-approach` or `reconcile`.
 */

package com.tramio.location

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingClient
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlin.math.PI
import kotlin.math.cos

/**
 * The registered module name. MUST match the `RCT_EXPORT_MODULE` value
 * on iOS and `TRAMIO_LOCATION_SERVICE_MODULE_NAME` in the JS spec.
 */
internal const val MODULE_NAME = "TramioLocationService"

// ---------------------------------------------------------------------------
// Event and mode string constants — duplicated verbatim from the iOS side
// so JS subscribers see identical wire payloads regardless of platform.
// ---------------------------------------------------------------------------

internal const val EVENT_ACCEPTED          = "onAccepted"
internal const val EVENT_REJECTED          = "onRejected"
internal const val EVENT_GEOFENCE_ENTER    = "onGeofenceEnter"
internal const val EVENT_GEOFENCE_DWELL    = "onGeofenceDwell"
internal const val EVENT_GEOFENCE_EXIT     = "onGeofenceExit"
internal const val EVENT_ACCURACY_CHANGED  = "onAccuracyChanged"

internal const val MODE_IDLE          = "idle"
internal const val MODE_STANDBY       = "standby"
internal const val MODE_TOUR_BG       = "tour-bg"
internal const val MODE_TOUR_APPROACH = "tour-approach"
internal const val MODE_RECONCILE     = "reconcile"

/** Hard limits enforced by the native pipeline — match the iOS constants. */
internal const val MAX_ACCURACY_METERS = 50.0
internal const val MAX_GROUND_SPEED_MPS = 33.33   // 120 km/h
internal const val REGION_WINDOW_SIZE = 18

// Foreground/background interval choices. The exact intervals don't
// matter much because the geofence client is what produces the
// authoritative trigger events; FusedLocationProvider continuous updates
// are used for the smoothing window, accuracy gate, and spike rejection.
private const val INTERVAL_HIGH_MS = 1_000L
private const val INTERVAL_BALANCED_MS = 10_000L

private const val TAG = "Tramio.Location"

class TramioLocationServiceModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    // -----------------------------------------------------------------------
    // Singleton hook for the broadcast receiver.
    //
    // GeofencingClient delivers DWELL+ENTER+EXIT to a `BroadcastReceiver`
    // (`TramioGeofenceBroadcastReceiver`). The receiver runs in the same
    // process as the module, so we register a process-lifetime singleton
    // here and the receiver forwards parsed events back through it.
    // -----------------------------------------------------------------------
    companion object {
        @Volatile
        @JvmStatic
        internal var sharedInstance: TramioLocationServiceModule? = null
    }

    private val fusedClient: FusedLocationProviderClient =
        LocationServices.getFusedLocationProviderClient(reactContext)
    private val geofencingClient: GeofencingClient =
        LocationServices.getGeofencingClient(reactContext)

    private var currentMode: String = MODE_IDLE
    private var hasJsListeners: Boolean = false
    private var highAccuracyActive: Boolean = false

    /**
     * Most recent accepted location. Used both for spike rejection
     * (compare ground speed to previous fix) and for ranking geofences
     * by distance for the sliding window.
     */
    private var lastAcceptedLocation: Location? = null

    /** Full geofence set as armed by JS. */
    private val allGeofences: MutableList<GeofenceEntry> = mutableListOf()

    /**
     * Subset of `allGeofences` (by `poiId`) currently registered with
     * the GeofencingClient.
     */
    private val armedPoiIds: MutableSet<String> = mutableSetOf()

    /** Cached pending intent used for every `addGeofences` call. */
    private val geofencePendingIntent: PendingIntent by lazy {
        val intent = Intent(reactContext, TramioGeofenceBroadcastReceiver::class.java).apply {
            action = TramioGeofenceBroadcastReceiver.ACTION_GEOFENCE_TRANSITION
        }
        // FLAG_MUTABLE is required on Android 12+ because GeofencingClient
        // mutates the intent to attach the GeofencingEvent extras.
        // FLAG_UPDATE_CURRENT keeps a single canonical PendingIntent so
        // re-registering geofences does not leak references.
        val flags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
        PendingIntent.getBroadcast(reactContext, /* requestCode = */ 0, intent, flags)
    }

    /** Single in-flight LocationCallback. Re-bound on every mode switch. */
    private val locationCallback: LocationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            for (loc in result.locations) {
                ingestLocation(loc)
            }
        }
    }

    init {
        sharedInstance = this
    }

    override fun getName(): String = MODULE_NAME

    override fun invalidate() {
        // Clean up when the React context is torn down (hot reload, app
        // shutdown). Releases system resources within ~1 frame.
        super.invalidate()
        stopAllNativeRequests()
        if (sharedInstance === this) {
            sharedInstance = null
        }
    }

    // -----------------------------------------------------------------------
    // RN codegen-required listener hooks. Consumers go through
    // NativeEventEmitter, not these methods. They exist only because the
    // turbo-module spec demands them.
    // -----------------------------------------------------------------------

    @ReactMethod
    fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {
        hasJsListeners = true
    }

    @ReactMethod
    fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Int) {
        // We treat any call here as "listeners may have detached"; the
        // actual count is tracked by NativeEventEmitter on the JS side.
        // Setting hasJsListeners = false here would race against new
        // subscriptions, so we keep it `true` and rely on the bridge to
        // stop dispatching when no listeners exist.
    }

    // -----------------------------------------------------------------------
    // JS-callable methods
    // -----------------------------------------------------------------------

    @ReactMethod
    fun setMode(mode: String) {
        if (mode.isEmpty()) return
        val previous = currentMode
        currentMode = mode
        applyMode(mode)

        // Drive the user-visible high-accuracy indicator (Req 11.5).
        val wasHigh = highAccuracyActive
        val nowHigh = (mode == MODE_TOUR_APPROACH || mode == MODE_RECONCILE)
        highAccuracyActive = nowHigh
        if (wasHigh != nowHigh) {
            emitAccuracyChanged(nowHigh, mode)
        }
        Log.i(TAG, "mode $previous -> $mode (highAccuracy=$nowHigh)")
    }

    @ReactMethod
    fun armGeofences(geofences: ReadableArray) {
        allGeofences.clear()
        for (i in 0 until geofences.size()) {
            val raw = geofences.getMap(i) ?: continue
            val entry = parseGeofenceMap(raw) ?: continue
            allGeofences.add(entry)
        }
        // Re-arm immediately using the most recent fix if we have one;
        // otherwise arm with the natural ordering and let the window
        // re-balance on the first accepted update.
        val ref = lastAcceptedLocation
        if (ref != null) {
            rearmRegionsForLocation(ref)
        } else {
            rearmRegionsForOrdering(allGeofences)
        }
    }

    @ReactMethod
    fun disarmAll() {
        stopAllNativeRequests()
        allGeofences.clear()
        armedPoiIds.clear()
        currentMode = MODE_IDLE
        lastAcceptedLocation = null
        if (highAccuracyActive) {
            emitAccuracyChanged(highAccuracy = false, mode = MODE_IDLE)
        }
        highAccuracyActive = false
    }

    // -----------------------------------------------------------------------
    // Mode application
    // -----------------------------------------------------------------------

    private fun applyMode(mode: String) {
        when (mode) {
            MODE_IDLE -> {
                stopContinuousUpdates()
                removeAllGeofences()
                stopForegroundService()
            }
            MODE_STANDBY, MODE_TOUR_BG -> {
                startForegroundService()
                startContinuousUpdates(highAccuracy = false)
                ensureGeofencesArmed()
            }
            MODE_TOUR_APPROACH, MODE_RECONCILE -> {
                startForegroundService()
                startContinuousUpdates(highAccuracy = true)
                ensureGeofencesArmed()
            }
            else -> {
                Log.w(TAG, "ignoring unknown mode $mode")
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun startContinuousUpdates(highAccuracy: Boolean) {
        if (!hasFineLocationPermission()) {
            Log.w(TAG, "ACCESS_FINE_LOCATION not granted; skipping continuous updates")
            return
        }
        // Stop any prior callback before starting a new one with the
        // updated priority. Re-binding the same callback is what changes
        // the request priority on FusedLocationProviderClient.
        fusedClient.removeLocationUpdates(locationCallback)

        val priority =
            if (highAccuracy) Priority.PRIORITY_HIGH_ACCURACY
            else Priority.PRIORITY_BALANCED_POWER_ACCURACY
        val intervalMs = if (highAccuracy) INTERVAL_HIGH_MS else INTERVAL_BALANCED_MS
        val request = LocationRequest.Builder(priority, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs)
            .setWaitForAccurateLocation(highAccuracy)
            .build()
        fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
    }

    private fun stopContinuousUpdates() {
        fusedClient.removeLocationUpdates(locationCallback)
    }

    private fun stopAllNativeRequests() {
        stopContinuousUpdates()
        removeAllGeofences()
        stopForegroundService()
    }

    @SuppressLint("MissingPermission")
    private fun ensureGeofencesArmed() {
        // If the JS side has armed entries but the OS-level set is
        // empty, re-issue the addGeofences call. This is what runs the
        // first time a tour switches into an active mode after
        // `armGeofences` was invoked in idle.
        if (armedPoiIds.isEmpty() && allGeofences.isNotEmpty()) {
            val ref = lastAcceptedLocation
            if (ref != null) {
                rearmRegionsForLocation(ref)
            } else {
                rearmRegionsForOrdering(allGeofences)
            }
        }
    }

    private fun removeAllGeofences() {
        if (armedPoiIds.isEmpty()) return
        val ids = armedPoiIds.toList()
        geofencingClient.removeGeofences(ids)
        armedPoiIds.clear()
    }

    // -----------------------------------------------------------------------
    // Foreground service (Req 12.1, 12.2)
    // -----------------------------------------------------------------------

    private fun startForegroundService() {
        val intent = Intent(reactContext, TramioTourForegroundService::class.java).apply {
            action = TramioTourForegroundService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }

    private fun stopForegroundService() {
        val intent = Intent(reactContext, TramioTourForegroundService::class.java).apply {
            action = TramioTourForegroundService.ACTION_STOP
        }
        reactContext.startService(intent)
    }

    // -----------------------------------------------------------------------
    // Geofence parsing
    // -----------------------------------------------------------------------

    private fun parseGeofenceMap(map: ReadableMap): GeofenceEntry? {
        val poiId = map.takeIf { it.hasKey("poiId") }?.getString("poiId") ?: return null
        if (poiId.isEmpty()) return null
        val geometry = map.takeIf { it.hasKey("geometry") }?.getMap("geometry") ?: return null
        val dwellSec =
            if (map.hasKey("dwellSec") && !map.isNull("dwellSec")) map.getDouble("dwellSec") else 3.0
        val kind = geometry.takeIf { it.hasKey("kind") }?.getString("kind") ?: return null

        return when (kind) {
            "circle" -> {
                val center = geometry.takeIf { it.hasKey("center") }?.getArray("center")
                    ?: return null
                if (center.size() < 2) return null
                val radius =
                    if (geometry.hasKey("radiusMeters")) geometry.getDouble("radiusMeters")
                    else return null
                GeofenceEntry(
                    poiId = poiId,
                    centerLat = center.getDouble(0),
                    centerLon = center.getDouble(1),
                    radiusMeters = radius,
                    dwellSec = dwellSec,
                )
            }
            "polygon" -> {
                val vertices = geometry.takeIf { it.hasKey("vertices") }?.getArray("vertices")
                    ?: return null
                if (vertices.size() == 0) return null
                // Compute centroid + max-radius circumscribing circle.
                // The JS-side dwell stage re-checks polygon containment,
                // so this only needs to be conservative enough to wake
                // the OS-level geofence.
                var sumLat = 0.0
                var sumLon = 0.0
                var n = 0
                for (i in 0 until vertices.size()) {
                    val v = vertices.getArray(i) ?: continue
                    if (v.size() < 2) continue
                    sumLat += v.getDouble(0)
                    sumLon += v.getDouble(1)
                    n++
                }
                if (n == 0) return null
                val centroidLat = sumLat / n
                val centroidLon = sumLon / n
                var maxSq = 0.0
                for (i in 0 until vertices.size()) {
                    val v = vertices.getArray(i) ?: continue
                    if (v.size() < 2) continue
                    val sq = squaredDistanceMeters(
                        centroidLat, centroidLon,
                        v.getDouble(0), v.getDouble(1),
                    )
                    if (sq > maxSq) maxSq = sq
                }
                GeofenceEntry(
                    poiId = poiId,
                    centerLat = centroidLat,
                    centerLon = centroidLon,
                    radiusMeters = kotlin.math.sqrt(maxSq),
                    dwellSec = dwellSec,
                )
            }
            else -> null
        }
    }

    // -----------------------------------------------------------------------
    // Sliding region window (Req: parity with iOS 20-region cap)
    // -----------------------------------------------------------------------

    private fun rearmRegionsForLocation(reference: Location) {
        val sorted = allGeofences.sortedWith(
            compareBy<GeofenceEntry> { entry ->
                squaredDistanceMeters(
                    entry.centerLat, entry.centerLon,
                    reference.latitude, reference.longitude,
                )
            }.thenBy { it.poiId }
        )
        rearmRegionsForOrdering(sorted)
    }

    @SuppressLint("MissingPermission")
    private fun rearmRegionsForOrdering(ordered: List<GeofenceEntry>) {
        if (!hasFineLocationPermission()) {
            Log.w(TAG, "ACCESS_FINE_LOCATION not granted; skipping geofence arm")
            return
        }
        val windowSize = minOf(REGION_WINDOW_SIZE, ordered.size)
        val desired = LinkedHashMap<String, GeofenceEntry>(windowSize)
        for (i in 0 until windowSize) {
            val entry = ordered[i]
            desired[entry.poiId] = entry
        }

        // Stop monitoring regions that fell out of the window.
        val toRemove = armedPoiIds.toMutableSet().also { it.removeAll(desired.keys) }
        if (toRemove.isNotEmpty()) {
            geofencingClient.removeGeofences(toRemove.toList())
            armedPoiIds.removeAll(toRemove)
        }

        // Start monitoring regions that entered the window.
        val toAdd = desired.keys.toMutableSet().also { it.removeAll(armedPoiIds) }
        if (toAdd.isEmpty()) return

        val newGeofences = toAdd.mapNotNull { id -> desired[id] }.map { entry ->
            // GeofencingClient requires a positive radius. Bound by 1 m
            // to defend against ill-formed authoring input.
            val radius = entry.radiusMeters.coerceAtLeast(1.0).toFloat()
            // `dwellSec` is the time the user must stay inside before the
            // engine fires; convert to ms for `setLoiteringDelay`.
            val loiteringDelayMs = (entry.dwellSec * 1000.0).toInt().coerceAtLeast(0)
            Geofence.Builder()
                .setRequestId(entry.poiId)
                .setCircularRegion(entry.centerLat, entry.centerLon, radius)
                .setExpirationDuration(Geofence.NEVER_EXPIRE)
                .setTransitionTypes(
                    Geofence.GEOFENCE_TRANSITION_ENTER or
                        Geofence.GEOFENCE_TRANSITION_DWELL or
                        Geofence.GEOFENCE_TRANSITION_EXIT
                )
                .setLoiteringDelay(loiteringDelayMs)
                .build()
        }

        val request = GeofencingRequest.Builder()
            .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER)
            .addGeofences(newGeofences)
            .build()
        geofencingClient.addGeofences(request, geofencePendingIntent)
            .addOnSuccessListener {
                armedPoiIds.addAll(toAdd)
            }
            .addOnFailureListener { err ->
                Log.e(TAG, "addGeofences failed", err)
            }
    }

    // -----------------------------------------------------------------------
    // Stage 1 + 2 native filtering (accepted-update pipeline)
    // -----------------------------------------------------------------------

    private fun ingestLocation(loc: Location) {
        // Stage 1: accuracy gate (Req 5.1). Android sets `hasAccuracy()`
        // to false when the provider could not estimate accuracy;
        // treat that as a reject.
        if (!loc.hasAccuracy() || loc.accuracy.toDouble() > MAX_ACCURACY_METERS) {
            emitRejected(loc, reason = "accuracy")
            return
        }

        // Stage 2: spike rejection (Req 5.2). We compare against the
        // most recent accepted update; iOS uses `CLLocation.timestamp`
        // and Android uses `Location.time` which is wall-clock ms since
        // epoch. Using device wall-clock is acceptable here because
        // FusedLocationProviderClient stamps `time` at the moment the
        // fix was acquired, not at delivery, which is what the spec
        // requires.
        val prev = lastAcceptedLocation
        if (prev != null) {
            val dtMs = loc.time - prev.time
            if (dtMs > 0L) {
                val dist = haversineMeters(
                    prev.latitude, prev.longitude,
                    loc.latitude, loc.longitude,
                )
                val mps = dist / (dtMs / 1000.0)
                if (mps > MAX_GROUND_SPEED_MPS) {
                    emitRejected(loc, reason = "spike")
                    return
                }
            } else if (dtMs == 0L &&
                loc.latitude == prev.latitude &&
                loc.longitude == prev.longitude
            ) {
                // Duplicate fix at the exact same timestamp.
                emitRejected(loc, reason = "duplicate")
                return
            }
        }

        lastAcceptedLocation = loc
        rearmRegionsForLocation(loc)
        emitAccepted(loc)
    }

    // -----------------------------------------------------------------------
    // Geofence transition entrypoint (called by the broadcast receiver)
    // -----------------------------------------------------------------------

    /**
     * Called by `TramioGeofenceBroadcastReceiver` after parsing a
     * `GeofencingEvent`. Forwards each transitioning region to JS as
     * the appropriate event.
     */
    internal fun handleGeofenceTransition(transitionType: Int, poiIds: List<String>, ts: Long) {
        val event = when (transitionType) {
            Geofence.GEOFENCE_TRANSITION_ENTER -> EVENT_GEOFENCE_ENTER
            Geofence.GEOFENCE_TRANSITION_DWELL -> EVENT_GEOFENCE_DWELL
            Geofence.GEOFENCE_TRANSITION_EXIT  -> EVENT_GEOFENCE_EXIT
            else -> return
        }
        for (id in poiIds) {
            val body = Arguments.createMap().apply {
                putString("poiId", id)
                putDouble("ts", ts.toDouble())
            }
            emit(event, body)
        }
    }

    // -----------------------------------------------------------------------
    // Event emission
    // -----------------------------------------------------------------------

    private fun emit(eventName: String, body: WritableMap) {
        if (!hasJsListeners) return
        if (!reactContext.hasActiveReactInstance()) return
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, body)
    }

    private fun emitAccepted(loc: Location) {
        val coord: WritableArray = Arguments.createArray().apply {
            pushDouble(loc.latitude)
            pushDouble(loc.longitude)
        }
        val body = Arguments.createMap().apply {
            putDouble("ts", loc.time.toDouble())
            putArray("coord", coord)
            putDouble("accuracyM", loc.accuracy.toDouble())
            if (loc.hasSpeed()) putDouble("speedMps", loc.speed.toDouble())
            if (loc.hasBearing()) putDouble("headingDeg", loc.bearing.toDouble())
            putString("mode", currentMode)
        }
        emit(EVENT_ACCEPTED, body)
    }

    private fun emitRejected(loc: Location, reason: String) {
        val coord: WritableArray = Arguments.createArray().apply {
            pushDouble(loc.latitude)
            pushDouble(loc.longitude)
        }
        val accuracy = if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0
        val body = Arguments.createMap().apply {
            putString("reason", reason)
            putDouble("ts", loc.time.toDouble())
            putArray("coord", coord)
            putDouble("accuracyM", accuracy)
        }
        emit(EVENT_REJECTED, body)
    }

    private fun emitAccuracyChanged(highAccuracy: Boolean, mode: String) {
        val body = Arguments.createMap().apply {
            putBoolean("highAccuracy", highAccuracy)
            putString("mode", mode)
        }
        emit(EVENT_ACCURACY_CHANGED, body)
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private fun hasFineLocationPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            reactContext,
            Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
    }
}

/**
 * Internal geofence representation. Polygons are converted to a
 * circumscribing circle for OS-level monitoring; the JS-side dwell
 * stage re-checks precise containment.
 */
internal data class GeofenceEntry(
    val poiId: String,
    val centerLat: Double,
    val centerLon: Double,
    val radiusMeters: Double,
    val dwellSec: Double,
)

// ---------------------------------------------------------------------------
// Math helpers — internal so the broadcast receiver and unit tests can
// reuse the same primitives.
// ---------------------------------------------------------------------------

private const val METERS_PER_DEG_LAT = 111_320.0
private const val EARTH_RADIUS_METERS = 6_371_000.0

/**
 * Squared great-circle distance approximation (equirectangular). Used
 * only for ranking the nearest 18 geofences; the relative ordering is
 * what matters, not the exact distance.
 */
internal fun squaredDistanceMeters(
    aLat: Double, aLon: Double,
    bLat: Double, bLon: Double,
): Double {
    val dLat = (aLat - bLat) * METERS_PER_DEG_LAT
    val meanLatRad = ((aLat + bLat) / 2.0) * (PI / 180.0)
    val dLon = (aLon - bLon) * METERS_PER_DEG_LAT * cos(meanLatRad)
    return dLat * dLat + dLon * dLon
}

/**
 * Exact great-circle distance in meters. Used by spike rejection so the
 * speed comparison is correct over the long edges (10–100 m) typical of
 * urban transit fixes.
 */
internal fun haversineMeters(
    aLat: Double, aLon: Double,
    bLat: Double, bLon: Double,
): Double {
    val phi1 = aLat * PI / 180.0
    val phi2 = bLat * PI / 180.0
    val dPhi = (bLat - aLat) * PI / 180.0
    val dLambda = (bLon - aLon) * PI / 180.0

    val sinDPhi2 = kotlin.math.sin(dPhi / 2.0)
    val sinDLam2 = kotlin.math.sin(dLambda / 2.0)
    val a = sinDPhi2 * sinDPhi2 +
        kotlin.math.cos(phi1) * kotlin.math.cos(phi2) * sinDLam2 * sinDLam2
    val c = 2.0 * kotlin.math.atan2(kotlin.math.sqrt(a), kotlin.math.sqrt(1.0 - a))
    return EARTH_RADIUS_METERS * c
}
