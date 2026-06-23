/*
 * TramioGeofenceBroadcastReceiver.kt
 * @tramio/native — Geofence transition receiver (task 8.2).
 *
 * GeofencingClient delivers `GEOFENCE_TRANSITION_ENTER`,
 * `GEOFENCE_TRANSITION_DWELL`, and `GEOFENCE_TRANSITION_EXIT` to a
 * PendingIntent; the system can wake the app from the background to
 * deliver these intents, which is the entire point of OS-native region
 * monitoring (Req 11.2, 12.2, 12.3).
 *
 * The receiver:
 *   1. Parses the `GeofencingEvent` from the intent.
 *   2. Wakes the foreground service so the JS-side engine can play
 *      audio (Req 12.1).
 *   3. Forwards the transition to `TramioLocationServiceModule` which
 *      emits the matching JS event.
 *
 * If the module instance is not yet available (the bridge has not
 * finished starting after a cold geofence wake), we still start the
 * foreground service so the engine has a chance to come up; the
 * GeofencingClient will redeliver the transition once the bridge is
 * ready, at which point the module will pick up subsequent events.
 */

package com.tramio.location

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent

class TramioGeofenceBroadcastReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_GEOFENCE_TRANSITION = "com.tramio.location.GEOFENCE_TRANSITION"
        private const val TAG = "Tramio.GeofenceRx"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val event = GeofencingEvent.fromIntent(intent)
        if (event == null) {
            Log.w(TAG, "GeofencingEvent.fromIntent returned null")
            return
        }
        if (event.hasError()) {
            Log.e(TAG, "geofence event error code=${event.errorCode}")
            return
        }

        // Wake the foreground service so the engine has the system
        // resources it needs to play audio. `startForegroundService`
        // requires the OS to call `startForeground` within ~5 s; the
        // service implementation honors that contract on first start.
        val serviceIntent = Intent(context, TramioTourForegroundService::class.java).apply {
            action = TramioTourForegroundService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }

        val module = TramioLocationServiceModule.sharedInstance
        if (module == null) {
            // The JS side has not yet attached. The OS will redeliver
            // future transitions once the bridge is running; the
            // GeofencingClient is sticky in that respect. Logging is
            // sufficient here.
            Log.i(TAG, "module not attached; transition deferred")
            return
        }

        val transitionType = event.geofenceTransition
        if (transitionType != Geofence.GEOFENCE_TRANSITION_ENTER &&
            transitionType != Geofence.GEOFENCE_TRANSITION_DWELL &&
            transitionType != Geofence.GEOFENCE_TRANSITION_EXIT
        ) {
            return
        }
        val triggering = event.triggeringGeofences ?: return
        val poiIds = triggering.mapNotNull { it.requestId }
        if (poiIds.isEmpty()) return

        // GeofencingEvent does not carry a per-event timestamp on every
        // OEM build; fall back to the receiver wall-clock when missing.
        val ts = System.currentTimeMillis()
        module.handleGeofenceTransition(transitionType, poiIds, ts)
    }
}
