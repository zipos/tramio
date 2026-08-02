// deskDebug — __DEV__-only desk tour tooling.
//
// Metro replaces `__DEV__` with `false` in production bundles, so callers that
// gate on `IS_DESK_DEBUG` are tree-shaken out of release builds.

import type { AcceptedUpdate, Geofence, LatLng, StartTourConfig } from '../../../engine/src';
import { projectOnRoute } from '../../../engine/src';
import { buildWarsaw180DeskTrace } from './warsawDeskTrace';
import {
  BASE_TRACE_SPEED_KMH,
  DESK_TRIP_KMH_SPEEDS,
  DESK_TRIP_SPEEDS,
  startGpsReplay,
  type DeskTripKmhSpeed,
  type DeskTripSpeed,
  type GpsReplayHandle,
} from './gpsReplay';

/** Compile-time desk/debug gate. Always true for dev & testing builds. */
export const IS_DESK_DEBUG: boolean = true;

export {
  BASE_TRACE_SPEED_KMH,
  DESK_TRIP_KMH_SPEEDS,
  DESK_TRIP_SPEEDS,
  type DeskTripKmhSpeed,
  type DeskTripSpeed,
};

export interface DeskDebugPorts {
  /** Feed a fix into the location adapter (replay or trusted snap). */
  injectFix: (loc: {
    coords: {
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude: null;
      altitudeAccuracy: null;
      heading: number | null;
      speed: number | null;
    };
    timestamp: number;
  }) => void;
  /** Reset pipeline spike/smoothing around a snap so jumps are not rejected. */
  resyncPipelineAt: (coord: LatLng, accuracyM: number) => void;
  /** Dispatch a fabricated accepted update for distance UI. */
  acceptPosition: (update: AcceptedUpdate) => void;
  finishPlayingSegment: (segmentId: string) => void;
  stopPlayback: () => void;
  triggerPoi: (poiId: string) => void;
  getPlayingSegmentId: () => string | null;
  getConsumed: () => ReadonlySet<string>;
  getAlongRouteM?: () => number;
  getConfig: () => StartTourConfig | undefined;
  onTripSpeedChange?: (speedKmh: number) => void;
  onReplayComplete?: () => void;
  noteFixWallClock?: () => void;
}

export interface DeskDebugSession {
  start(opts?: { speedMultiplier?: number; poiCount?: number }): void;
  stop(): void;
  setTripSpeed(speedKmh: number): void;
  getTripSpeed(): number;
  /** Skip audio + seek GPS cursor + snap rider to next POI ahead on the route. */
  skipToNextPoi(): boolean;
  isActive(): boolean;
  isReplayComplete(): boolean;
}

/**
 * Create a desk-debug session. Returns null in production (`IS_DESK_DEBUG` false).
 */
export function createDeskDebugSession(ports: DeskDebugPorts): DeskDebugSession | null {
  if (!IS_DESK_DEBUG) return null;
  let handle: GpsReplayHandle | null = null;
  let tripSpeedKmh = 21; // Default 21 km/h (standard Warsaw bus average speed)
  let active = false;

  const snapRider = (coord: LatLng, route: readonly LatLng[]): void => {
    const accuracyM = 8;
    ports.resyncPipelineAt(coord, accuracyM);
    const projection = projectOnRoute(route, coord);
    const update: AcceptedUpdate = {
      ts: Date.now(),
      coord,
      accuracyM,
      smoothed: coord,
      alongRouteM: projection.alongRouteM,
      speedMps: 0,
    };
    ports.acceptPosition(update);
    ports.noteFixWallClock?.();
    ports.injectFix({
      coords: {
        latitude: coord[0],
        longitude: coord[1],
        accuracy: accuracyM,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: 0,
      },
      timestamp: Date.now(),
    });
  };

  return {
    start(opts) {
      if (active) this.stop();
      // Calculate multiplier from requested speed in km/h relative to base trace speed (28.8 km/h).
      const rawMultiplier = opts?.speedMultiplier;
      if (rawMultiplier != null) {
        // If passed a multiplier directly (e.g. 1.0, 2.0), translate to km/h or use directly
        tripSpeedKmh =
          rawMultiplier > 5 ? rawMultiplier : Math.round(rawMultiplier * BASE_TRACE_SPEED_KMH);
      } else {
        tripSpeedKmh = 21;
      }

      const speedMultiplier = tripSpeedKmh / BASE_TRACE_SPEED_KMH;

      const fixes = buildWarsaw180DeskTrace(
        opts?.poiCount != null ? { poiCount: opts.poiCount } : undefined,
      );
      handle = startGpsReplay({
        fixes,
        speedMultiplier,
        onFix: (loc) => {
          ports.injectFix(loc);
          ports.noteFixWallClock?.();
        },
        onComplete: () => ports.onReplayComplete?.(),
        onSpeedChange: (mult) => {
          tripSpeedKmh = Math.round(mult * BASE_TRACE_SPEED_KMH);
          ports.onTripSpeedChange?.(tripSpeedKmh);
        },
      });
      active = true;
      ports.onTripSpeedChange?.(tripSpeedKmh);
    },

    stop() {
      handle?.stop();
      handle = null;
      active = false;
    },

    setTripSpeed(speedKmh: number) {
      tripSpeedKmh = Math.max(5, Math.min(300, speedKmh));
      const mult = tripSpeedKmh / BASE_TRACE_SPEED_KMH;
      handle?.setSpeedMultiplier(mult);
      ports.onTripSpeedChange?.(tripSpeedKmh);
    },

    getTripSpeed() {
      return tripSpeedKmh;
    },

    skipToNextPoi() {
      const config = ports.getConfig();
      if (!config) return false;

      const currentAlongRouteM = ports.getAlongRouteM?.() ?? 0;
      const consumed = ports.getConsumed();

      // FIX: Find the nearest POI strictly AHEAD of current along-route distance (+5m threshold).
      // This prevents jumping backwards to a previously skipped POI!
      const next = config.geofences.find((g) => {
        if (g.geometry.kind !== 'circle') return false;
        const proj = projectOnRoute(config.route, g.geometry.center);
        return proj.alongRouteM > currentAlongRouteM + 5 && !consumed.has(g.poiId);
      });

      if (!next || next.geometry.kind !== 'circle') return false;

      const center = next.geometry.center;

      // 1. Stop current narration cleanly if active.
      const playingId = ports.getPlayingSegmentId();
      if (playingId) {
        ports.stopPlayback();
        ports.finishPlayingSegment(playingId);
      }

      // 2. Resync the geofence pipeline so the jump is accepted without spike rejection.
      ports.resyncPipelineAt(center, 8);

      // 3. Seek the GPS cursor AND snap the rider position to the target POI.
      if (handle) {
        handle.seekToCoord(center, Math.max(40, next.geometry.radiusMeters));
      }
      snapRider(center, config.route);

      // 4. Trigger narration for the next POI.
      ports.triggerPoi(next.poiId);
      return true;
    },

    isActive() {
      return active && handle !== null;
    },

    isReplayComplete() {
      return handle?.isComplete() ?? false;
    },
  };
}

export function geofenceCenter(fence: Geofence): LatLng | null {
  return fence.geometry.kind === 'circle' ? fence.geometry.center : null;
}
