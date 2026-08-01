// backgroundLocationTask — background-capable location delivery for active tours.
//
// expo-location's foreground watch pauses when the app backgrounds. This module
// registers a TaskManager location-updates task so GPS fixes keep flowing while
// the phone is pocketed, feeding the same JS geofence pipeline used in the
// foreground.
//
// The task must be defined at module load time (imported from index.ts before
// the app root component).
//
// BUG 3 FIX: When the task callback fires with no bound session (app was
// killed mid-tour and cold-started by the OS to deliver location), we
// self-heal by stopping background updates. Guarded to run at most once
// per cold start to prevent a stop-storm.
//
// BUG 5 FIX: After a pipeline fire, advance the stored pipeline state's
// consumed set so the pipeline short-circuits that POI on subsequent fixes.
// Also drop the fired POI's dwell entry. Pure value update — no engine
// mutation.

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
  /** Every provider callback, before filtering. Coordinates are intentionally excluded. */
  onDelivered?: (meta: { accuracyM: number | null }) => void;
  /** A provider callback rejected by the pure pipeline. */
  onRejected?: (meta: { reason: 'accuracy' | 'spike'; accuracyM: number | null }) => void;
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

// BUG 3 FIX: guard to prevent a stop-storm — only attempt the orphan
// self-heal once per cold start.
let orphanStopAttempted = false;

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
  // Reset the orphan guard when a new session binds (new tour started).
  orphanStopAttempted = false;
}

export function unbindLocationSession(): void {
  session = null;
}

function runOnMainThread(fn: () => void): void {
  InteractionManager.runAfterInteractions(fn);
}

function ingestLocation(loc: Location.LocationObject): void {
  if (session === null || !session.isActive()) return;

  const boundSession = session;
  const events = boundSession.events;
  events.onDelivered?.({ accuracyM: loc.coords.accuracy ?? null });

  const raw: PositionUpdate = {
    ts: loc.timestamp,
    coord: [loc.coords.latitude, loc.coords.longitude],
    accuracyM: loc.coords.accuracy ?? 9999,
    ...(loc.coords.speed != null ? { speedMps: loc.coords.speed } : {}),
    ...(loc.coords.heading != null ? { headingDeg: loc.coords.heading } : {}),
  };

  const out = step(boundSession.pipeline, raw, raw.ts);
  if (isRejected(out)) {
    events.onRejected?.({ reason: out.reject, accuracyM: loc.coords.accuracy ?? null });
    return;
  }

  // BUG 5 FIX: after a fire, advance the consumed set and drop dwell entry
  // so the pipeline short-circuits that POI on subsequent fixes.
  let nextPipeline = out.nextState;
  if (out.fire !== undefined) {
    const newConsumed = new Set(nextPipeline.consumed);
    newConsumed.add(out.fire);
    // Drop the fired POI's dwell entry — it will never fire again.
    const { [out.fire]: _dropped, ...remainingDwell } = nextPipeline.dwell;
    nextPipeline = {
      ...nextPipeline,
      consumed: newConsumed,
      dwell: remainingDwell,
    };
  }

  boundSession.pipeline = nextPipeline;

  const fire = out.fire;
  runOnMainThread(() => {
    if (session !== boundSession || !boundSession.isActive()) return;
    events.onAccepted({
      ts: raw.ts,
      coord: raw.coord,
      accuracyM: raw.accuracyM,
      smoothed: out.accepted.smoothed,
      alongRouteM: out.accepted.alongRouteM,
      ...(raw.speedMps != null ? { speedMps: raw.speedMps } : {}),
      ...(raw.headingDeg != null ? { headingDeg: raw.headingDeg } : {}),
    });
    if (fire !== undefined) {
      events.onGeofenceDwell(fire);
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

    // BUG 3 FIX: if there is no bound session, the app was killed mid-tour
    // and cold-started by the OS. Self-heal by stopping updates so GPS does
    // not run forever draining the battery.
    if (session === null) {
      if (!orphanStopAttempted) {
        orphanStopAttempted = true;
        void stopBackgroundLocationUpdates().catch(() => undefined);
      }
      return;
    }

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
