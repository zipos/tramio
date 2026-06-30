// locationAdapter — bridges expo-location to the engine's geofence pipeline.
//
// The custom Location_Service turbo module (packages/native/) is not
// autolinked into the Expo prebuild, so instead we drive the already-built
// pure-JS geofence pipeline (packages/engine/src/pipeline) from real GPS
// fixes delivered by expo-location, which IS autolinked.
//
// Responsibilities:
//   - Request foreground (+ background) location permission.
//   - Prefer TaskManager background location updates so fixes keep flowing
//     when the app is pocketed; fall back to a foreground watch otherwise.
//   - Feed each raw fix through `step()` (accuracy gate, spike rejection,
//     smoothing, dwell, direction filter).
//   - Emit `LocationAccepted` and `GeofenceDwell` engine events.

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
    if (status !== Location.PermissionStatus.GRANTED) {
      this.events.onPermissionDenied();
      return;
    }

    this.active = true;
    bindLocationSession(this.route, this.geofences, this.events, () => this.active);

    const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
    if (bgStatus === Location.PermissionStatus.GRANTED) {
      try {
        await startBackgroundLocationUpdates();
        return;
      } catch {
        // Fall through to foreground-only watch.
      }
    }

    this.watch = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 1000,
        distanceInterval: 1,
      },
      (loc) => ingestLocationFix(loc),
    );
  }

  /** Stop watching and release the subscription. */
  stop(): void {
    this.active = false;
    if (this.watch) {
      this.watch.remove();
      this.watch = null;
    }
    void stopBackgroundLocationUpdates().catch(() => undefined);
    unbindLocationSession();
  }
}
