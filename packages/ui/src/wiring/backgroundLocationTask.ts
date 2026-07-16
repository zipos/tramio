// backgroundLocationTask — background-capable location delivery for active tours.
//
// expo-location's foreground watch pauses when the app backgrounds. This module
// registers a TaskManager location-updates task so GPS fixes keep flowing while
// the phone is pocketed, feeding the same JS geofence pipeline used in the
// foreground.
//
// The task must be defined at module load time (imported from index.ts before
// the app root component).

import { InteractionManager, Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import {
  initialPipelineState,
  isRejected,
  step,
  type PipelineState,
  type Geofence,
  type LatLng,
  type PositionUpdate,
} from '../../../engine/src';

import { ensureAndroidPostNotificationsPermission } from './androidPermissions';

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

export const LOCATION_TASK_NAME = 'tramio-location-updates';

type LocationTaskData = {
  locations: Location.LocationObject[];
};

interface LocationSession {
  pipeline: PipelineState;
  events: LocationAdapterEvents;
  isActive: () => boolean;
}

let session: LocationSession | null = null;

/** Bind the active tour's pipeline and event callbacks for the background task. */
export function bindLocationSession(
  route: readonly LatLng[],
  geofences: readonly Geofence[],
  events: LocationAdapterEvents,
  isActive: () => boolean,
): void {
  session = {
    pipeline: initialPipelineState(route, geofences),
    events,
    isActive,
  };
}

export function unbindLocationSession(): void {
  session = null;
}

function runOnMainThread(fn: () => void): void {
  InteractionManager.runAfterInteractions(fn);
}

function ingestLocation(loc: Location.LocationObject): void {
  if (session === null || !session.isActive()) return;

  const raw: PositionUpdate = {
    ts: loc.timestamp,
    coord: [loc.coords.latitude, loc.coords.longitude],
    accuracyM: loc.coords.accuracy ?? 9999,
    ...(loc.coords.speed != null ? { speedMps: loc.coords.speed } : {}),
    ...(loc.coords.heading != null ? { headingDeg: loc.coords.heading } : {}),
  };

  const out = step(session.pipeline, raw, raw.ts);
  if (isRejected(out)) return;

  session.pipeline = out.nextState;

  const events = session.events;
  runOnMainThread(() => {
    if (session === null || !session.isActive()) return;
    events.onAccepted({
      ts: raw.ts,
      coord: raw.coord,
      accuracyM: raw.accuracyM,
      smoothed: out.accepted.smoothed,
      alongRouteM: out.accepted.alongRouteM,
      ...(raw.speedMps != null ? { speedMps: raw.speedMps } : {}),
      ...(raw.headingDeg != null ? { headingDeg: raw.headingDeg } : {}),
    });
    if (out.fire !== undefined) {
      events.onGeofenceDwell(out.fire);
    }
  });
}

/** Ingest a single location fix through the bound session pipeline. */
export function ingestLocationFix(loc: Location.LocationObject): void {
  ingestLocation(loc);
}

export function ensureLocationTaskDefined(): void {
  if (TaskManager.isTaskDefined(LOCATION_TASK_NAME)) return;

  TaskManager.defineTask<LocationTaskData>(LOCATION_TASK_NAME, async ({ data, error }) => {
    if (error !== null) return;

    const locations = data?.locations ?? [];
    for (const loc of locations) {
      ingestLocation(loc);
    }
  });
}

/** Start background location updates (also delivers while foregrounded). */
export async function startBackgroundLocationUpdates(): Promise<void> {
  ensureLocationTaskDefined();

  if (Platform.OS === 'android') {
    const notificationsOk = await ensureAndroidPostNotificationsPermission();
    if (!notificationsOk) {
      throw new Error('POST_NOTIFICATIONS required for background location on Android');
    }
  }

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (alreadyRunning) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }

  const options: Location.LocationTaskOptions = {
    accuracy: Location.Accuracy.High,
    timeInterval: 1000,
    distanceInterval: 1,
    pausesUpdatesAutomatically: false,
    foregroundService: {
      notificationTitle: 'Tramio tour in progress',
      notificationBody: 'Playing landmark narration along your route',
      notificationColor: '#2563eb',
    },
  };

  if (Platform.OS === 'ios') {
    options.showsBackgroundLocationIndicator = true;
  }

  await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, options);
}

export async function stopBackgroundLocationUpdates(): Promise<void> {
  const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
  if (running) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }
}

ensureLocationTaskDefined();
