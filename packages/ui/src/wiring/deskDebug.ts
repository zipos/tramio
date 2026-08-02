// deskDebug — __DEV__-only desk tour tooling.
//
// Metro replaces `__DEV__` with `false` in production bundles, so callers that
// gate on `IS_DESK_DEBUG` are tree-shaken out of release builds.

import type { AcceptedUpdate, Geofence, LatLng, StartTourConfig } from '../../../engine/src';
import { projectOnRoute } from '../../../engine/src';
import { buildWarsaw180DeskTrace } from './warsawDeskTrace';
import {
  DESK_TRIP_SPEEDS,
  startGpsReplay,
  type GpsReplayHandle,
  type DeskTripSpeed,
} from './gpsReplay';

/** Compile-time desk/debug gate. False in production Metro bundles. */
export const IS_DESK_DEBUG: boolean =
  typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

export { DESK_TRIP_SPEEDS, type DeskTripSpeed };

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
  getConfig: () => StartTourConfig | undefined;
  onTripSpeedChange?: (speed: number) => void;
  onReplayComplete?: () => void;
  noteFixWallClock?: () => void;
}

export interface DeskDebugSession {
  start(opts?: { speedMultiplier?: number; poiCount?: number }): void;
  stop(): void;
  setTripSpeed(speed: number): void;
  getTripSpeed(): number;
  /** Skip audio + seek GPS cursor + snap rider to next POI. */
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
  let tripSpeed = 4;
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
      tripSpeed = opts?.speedMultiplier ?? 4;
      const fixes = buildWarsaw180DeskTrace(
        opts?.poiCount != null ? { poiCount: opts.poiCount } : undefined,
      );
      handle = startGpsReplay({
        fixes,
        speedMultiplier: tripSpeed,
        onFix: (loc) => {
          ports.injectFix(loc);
          ports.noteFixWallClock?.();
        },
        onComplete: () => ports.onReplayComplete?.(),
        onSpeedChange: (mult) => {
          tripSpeed = mult;
          ports.onTripSpeedChange?.(mult);
        },
      });
      active = true;
      ports.onTripSpeedChange?.(tripSpeed);
    },

    stop() {
      handle?.stop();
      handle = null;
      active = false;
    },

    setTripSpeed(speed: number) {
      tripSpeed = Math.max(0.25, speed);
      handle?.setSpeedMultiplier(tripSpeed);
      ports.onTripSpeedChange?.(tripSpeed);
    },

    getTripSpeed() {
      return tripSpeed;
    },

    skipToNextPoi() {
      const config = ports.getConfig();
      if (!config) return false;

      const consumed = ports.getConsumed();
      const next = config.geofences.find((g) => !consumed.has(g.poiId));
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

      // 3. Seek the GPS cursor to the next POI location.
      if (handle) {
        handle.seekToCoord(center, Math.max(40, next.geometry.radiusMeters));
      } else {
        snapRider(center, config.route);
      }

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
