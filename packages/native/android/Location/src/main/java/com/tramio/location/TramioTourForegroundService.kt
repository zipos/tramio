/*
 * TramioTourForegroundService.kt
 * @tramio/native — Foreground service for active-tour execution (task 8.2).
 *
 * The Android foreground service is what keeps the tour running while
 * the screen is locked or the app is backgrounded (Req 12.1, 12.2). The
 * service is intentionally minimal: it owns the sticky notification and
 * promotes the process to "foreground" so:
 *
 *   - `FusedLocationProviderClient` updates continue arriving.
 *   - `GeofencingClient` PendingIntents wake the receiver reliably even
 *     under Android's background process limits.
 *   - `ExoPlayer` (owned by Audio_Service in task 8.4) keeps decoding
 *     and rendering audio uninterrupted.
 *
 * `foregroundServiceType="location|mediaPlayback"` matches the manifest
 * declaration emitted by the `withTramioForegroundService` config plugin
 * in `plugins/withTramioForegroundService.js`. The two service types
 * cover both Location_Service (location) and Audio_Service (media
 * playback) so the same foreground service can host both modules
 * without re-declaration.
 *
 * START_STICKY ensures the OS recreates the service if it is killed
 * while the tour is active; the engine reconciles missed POIs on resume
 * per Req 6.4.
 */

package com.tramio.location

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class TramioTourForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.tramio.location.FOREGROUND_START"
        const val ACTION_STOP  = "com.tramio.location.FOREGROUND_STOP"

        /**
         * Notification ID for the sticky tour notification. Stable across
         * starts so re-issuing `startForeground` updates the existing
         * notification rather than creating a new one. The value is
         * arbitrary; we picked `0x5249` ("RI" — Tramio Ride Identifier)
         * to keep the magic-number readable in logs without colliding
         * with the typical 1..100 range used by app code.
         */
        private const val NOTIFICATION_ID = 0x5249
    }

    private var isStarted: Boolean = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForegroundCompat()
                stopSelf()
                isStarted = false
                return START_NOT_STICKY
            }
            else -> {
                // ACTION_START or null (recreate after kill).
                if (!isStarted) {
                    promoteToForeground()
                    isStarted = true
                }
            }
        }
        // STICKY so the OS recreates the service after a kill while the
        // tour is active. The engine handles missed-POI reconciliation
        // on resume per Req 6.4.
        return START_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        stopForegroundCompat()
        isStarted = false
    }

    // -----------------------------------------------------------------------
    // Foreground-promotion plumbing
    // -----------------------------------------------------------------------

    private fun promoteToForeground() {
        ensureNotificationChannel(this)
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ requires the foreground service type to be
            // declared on the `startForeground` call. Match the manifest
            // declaration: `location|mediaPlayback`.
            val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            startForeground(NOTIFICATION_ID, notification, type)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun buildNotification(): Notification {
        // Title / text are intentionally generic so the service can be
        // shared with Audio_Service later without a manifest change.
        // Localization is handled by the engine via `setNotificationText`
        // in a future revision; for the MVP, English copy is acceptable
        // because the sticky notification is brief and informational.
        return NotificationCompat.Builder(this, TRAMIO_FOREGROUND_CHANNEL_ID)
            .setContentTitle("Tramio tour active")
            .setContentText("Narration continues while your screen is locked.")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }
}

// ---------------------------------------------------------------------------
// Notification channel helper. Internal so future Audio_Service code in
// task 8.4 can reuse the same channel without redefining it.
// ---------------------------------------------------------------------------

internal const val TRAMIO_FOREGROUND_CHANNEL_ID = "tramio.tour.foreground"
internal const val TRAMIO_FOREGROUND_CHANNEL_NAME = "Tramio Tour"

internal fun ensureNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (mgr.getNotificationChannel(TRAMIO_FOREGROUND_CHANNEL_ID) != null) return
    val channel = NotificationChannel(
        TRAMIO_FOREGROUND_CHANNEL_ID,
        TRAMIO_FOREGROUND_CHANNEL_NAME,
        NotificationManager.IMPORTANCE_LOW,
    ).apply {
        description = "Keeps the active tour running in the background."
        setShowBadge(false)
    }
    mgr.createNotificationChannel(channel)
}
