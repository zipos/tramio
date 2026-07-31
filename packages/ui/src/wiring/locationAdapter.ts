// locationAdapter — bridges expo-location to the engine's geofence pipeline.
//
// The custom Location_Service turbo module (packages/native/) is not
// autolinked into the Expo prebuild, so instead we drive the already-built
// pure-JS geofence pipeline (packages/engine/src/pipeline) from real GPS
// fixes delivered by expo-location, which IS autolinked.
//
// Responsibilities:
//   - Request foreground (+ optional background) location permission.
//   - Always start a foreground watch so the tour works after the first grant.
//   - Optionally upgrade to TaskManager background updates when allowed.
//   - Feed each raw fix through `step()` (accuracy gate, spike rejection,
//     smoothing, dwell, direction filter).
//   - Emit `LocationAccepted` and `GeofenceDwell` engine events.
//
// BUG 4 FIX: Monotonic `cancelled` flag prevents async leaks. Once stop()
// is called, no further location watches or background updates can start,
// even if an awaited permission prompt resolves after the tour has ended.
//
// BUG 5 FIX: After a fire, advance the stored pipeline state's consumed
// set so the pipeline short-circuits that POI on subsequent fixes.
//
// BUG 6 FIX: Track and expose background status so the UI can warn.

import * as Location from 'expo-location';
import type { Geofence, LatLng } from '../../../engine/src';
import {
  bindLocationSession,
  ingestLocationFix,
  startBackgroundLocationUpdates,
  stopBackgroundLocationUpdates,
  unbindLocationSession,
  type LocationAdapterEvents,
} from './backgroundLocationTask';
import type { BackgroundStatus } from './TourRuntime';

export type { LocationAdapterEvents };

/**
 * Drives the engine geofence pipeline from real expo-location fixes.
 *
 * Construct once per tour with the route + geofences, call `start()` to
 * begin watching, and `stop()` to release the watch subscription.
 */
export class LocationAdapter {
  private watch: Location.LocationSubscription | null = null;
  private readonly route: readonly LatLng[];
  private readonly geofences: readonly Geofence[];
  private readonly events: LocationAdapterEvents;
  private active = false;

  // BUG 4 FIX: monotonic cancellation flag. Once set, no async continuation
  // may create watches or start background updates.
  private cancelled = false;

  /** Callback wired by TourRuntime to receive background status changes. */
  onBackgroundStatusChange: ((status: BackgroundStatus) => void) | null = null;

  constructor(
    route: readonly LatLng[],
    geofences: readonly Geofence[],
    events: LocationAdapterEvents,
  ) {
    this.route = route;
    this.geofences = geofences;
    this.events = events;
  }

  /**
   * Request permission and begin watching position. Resolves once the
   * watch is established (or rejects to the permission-denied callback).
   */
  async start(): Promise<void> {
    const { status } = await Location.requestForegroundPermissionsAsync();

    // BUG 4 FIX: check cancellation after every await.
    if (this.cancelled) return;

    if (status !== Location.PermissionStatus.GRANTED) {
      this.events.onPermissionDenied();
      return;
    }

    this.active = true;
    bindLocationSession(this.route, this.geofences, this.events, () => this.active);

    // Foreground watch first — reliable on all platforms and permission states.
    await this.startForegroundWatch();

    // BUG 4 FIX: check cancellation after foreground watch.
    if (this.cancelled) return;

    // Background is optional; never tear down a working foreground watch on failure.
    await this.tryEnableBackgroundUpdates();
  }

  /** Stop watching and release the subscription. Monotonic — cannot be undone. */
  stop(): void {
    // BUG 4 FIX: set the permanent cancellation flag so no async
    // continuation can re-arm watches after this point.
    this.cancelled = true;
    this.active = false;
    if (this.watch) {
      this.watch.remove();
      this.watch = null;
    }
    void stopBackgroundLocationUpdates().catch(() => undefined);
    unbindLocationSession();
  }

  private async startForegroundWatch(): Promise<void> {
    if (this.watch) return;
    if (this.cancelled) return;

    const subscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 1000,
        distanceInterval: 1,
      },
      (loc) => ingestLocationFix(loc),
    );

    // BUG 4 FIX: if cancelled while awaiting, immediately remove.
    if (this.cancelled) {
      subscription.remove();
      return;
    }

    this.watch = subscription;
  }

  private async tryEnableBackgroundUpdates(): Promise<void> {
    try {
      if (this.cancelled) return;

      let bgStatus = (await Location.getBackgroundPermissionsAsync()).status;

      if (this.cancelled) return;

      if (bgStatus !== Location.PermissionStatus.GRANTED) {
        bgStatus = (await Location.requestBackgroundPermissionsAsync()).status;
      }

      if (this.cancelled) return;

      if (bgStatus !== Location.PermissionStatus.GRANTED) {
        this.onBackgroundStatusChange?.({
          mode: 'foreground-only',
          reason: 'permission-denied',
        });
        return;
      }

      await startBackgroundLocationUpdates();

      // BUG 4 FIX: if cancelled while starting background updates, stop them.
      if (this.cancelled) {
        void stopBackgroundLocationUpdates().catch(() => undefined);
        return;
      }

      // Background updates are running — remove the foreground watch to avoid
      // duplicate fixes (background delivery also fires while foregrounded).
      if (this.watch) {
        this.watch.remove();
        this.watch = null;
      }

      this.onBackgroundStatusChange?.({ mode: 'background' });
    } catch (err: unknown) {
      // BUG 6 FIX: categorize the failure so the UI can show a reason.
      if (this.cancelled) return;

      const message = err instanceof Error ? err.message : '';
      if (message.includes('POST_NOTIFICATIONS')) {
        this.onBackgroundStatusChange?.({
          mode: 'foreground-only',
          reason: 'notifications-denied',
        });
      } else {
        this.onBackgroundStatusChange?.({
          mode: 'foreground-only',
          reason: 'unavailable',
        });
      }
      // Foreground watch keeps the tour running — no rethrow.
    }
  }
}
