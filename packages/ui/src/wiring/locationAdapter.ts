// locationAdapter — bridges expo-location to the engine's geofence pipeline.
//
// The custom Location_Service turbo module (packages/native/) is not
// autolinked into the Expo prebuild, so instead we drive the already-built
// pure-JS geofence pipeline (packages/engine/src/pipeline) from real GPS
// fixes delivered by expo-location, which IS autolinked.
//
// Responsibilities:
//   - Request foreground location permission.
//   - Start/stop watching position based on the engine's location mode.
//   - Feed each raw fix through `step()` (accuracy gate, spike rejection,
//     smoothing, dwell, direction filter).
//   - Emit `LocationAccepted` and `GeofenceDwell` engine events.
//
// This keeps all the tested filtering logic in play while using a real,
// linked native location provider.

import * as Location from 'expo-location';
import {
  initialPipelineState,
  isRejected,
  step,
  type PipelineState,
  type Geofence,
  type LatLng,
  type PositionUpdate,
} from '../../../engine/src';

export interface LocationAdapterEvents {
  onAccepted: (update: {
    ts: number;
    coord: LatLng;
    accuracyM: number;
    smoothed: LatLng;
    alongRouteM: number;
    speedMps?: number;
    headingDeg?: number;
  }) => void;
  onGeofenceDwell: (poiId: string) => void;
  onPermissionDenied: () => void;
}

/**
 * Drives the engine geofence pipeline from real expo-location fixes.
 *
 * Construct once per tour with the route + geofences, call `start()` to
 * begin watching, and `stop()` to release the watch subscription.
 */
export class LocationAdapter {
  private pipeline: PipelineState;
  private watch: Location.LocationSubscription | null = null;
  private readonly events: LocationAdapterEvents;
  private active = false;

  constructor(
    route: readonly LatLng[],
    geofences: readonly Geofence[],
    events: LocationAdapterEvents,
  ) {
    this.pipeline = initialPipelineState(route, geofences);
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
    this.watch = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 1000,
        distanceInterval: 1,
      },
      (loc) => this.ingest(loc),
    );
  }

  /** Stop watching and release the subscription. */
  stop(): void {
    this.active = false;
    if (this.watch) {
      this.watch.remove();
      this.watch = null;
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────

  private ingest(loc: Location.LocationObject): void {
    if (!this.active) return;

    const raw: PositionUpdate = {
      ts: loc.timestamp,
      coord: [loc.coords.latitude, loc.coords.longitude],
      accuracyM: loc.coords.accuracy ?? 9999,
      ...(loc.coords.speed != null ? { speedMps: loc.coords.speed } : {}),
      ...(loc.coords.heading != null ? { headingDeg: loc.coords.heading } : {}),
    };

    const out = step(this.pipeline, raw, raw.ts);
    if (isRejected(out)) {
      // Accuracy or spike rejection — drop the fix silently.
      return;
    }

    this.pipeline = out.nextState;

    this.events.onAccepted({
      ts: raw.ts,
      coord: raw.coord,
      accuracyM: raw.accuracyM,
      smoothed: out.accepted.smoothed,
      alongRouteM: out.accepted.alongRouteM,
      ...(raw.speedMps != null ? { speedMps: raw.speedMps } : {}),
      ...(raw.headingDeg != null ? { headingDeg: raw.headingDeg } : {}),
    });

    if (out.fire !== undefined) {
      this.events.onGeofenceDwell(out.fire);
    }
  }
}
