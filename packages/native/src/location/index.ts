/**
 * Typed JS-side facade for the `Location_Service` turbo module.
 *
 * Layers, top to bottom:
 *
 *   1. `NativeLocationService.ts` — codegen spec (loose `Object` payloads).
 *   2. This file — narrow generics + `NativeEventEmitter` plumbing,
 *      converting between engine-side `LocationMode` / `Geofence` shapes
 *      from `@tramio/engine` and the wire-level shapes the native module
 *      accepts.
 *   3. `command translators` (task 13.1) — consume `EngineCommand`s and
 *      drive this module.
 *
 * The translation layer is intentionally thin: every call surface here
 * preserves the field names declared in the engine's runtime types so
 * the only place that has to know the exact native payload format is
 * this module.
 *
 * Validates: Requirements 5.1, 5.2, 11.1, 11.2, 11.3, 11.4, 11.5, 12.2,
 *            12.3, 15.1
 */

import { NativeEventEmitter } from 'react-native';
import type { Geofence, LocationMode } from '../../../engine/src';

import LocationService, {
  NATIVE_LOCATION_EVENT_NAMES,
  TRAMIO_LOCATION_SERVICE_MODULE_NAME,
} from './NativeLocationService';
import type {
  NativeAcceptedPayload,
  NativeAccuracyChangedPayload,
  NativeGeofence,
  NativeGeofencePayload,
  NativeLocationEventName,
  NativeLocationMode,
  NativeRejectedPayload,
  Spec as NativeLocationSpec,
} from './NativeLocationService';

export type {
  NativeAcceptedPayload,
  NativeAccuracyChangedPayload,
  NativeGeofence,
  NativeGeofencePayload,
  NativeLocationEventName,
  NativeLocationMode,
  NativeRejectedPayload,
  NativeLocationSpec,
};

export { NATIVE_LOCATION_EVENT_NAMES, TRAMIO_LOCATION_SERVICE_MODULE_NAME };

/**
 * Listener subscription returned by `subscribe*` helpers. `remove()`
 * detaches the listener and decrements the native listener count.
 */
export interface LocationSubscription {
  remove(): void;
}

/**
 * Convert an engine-side `Geofence` into the wire shape the native
 * module expects. Pure / side-effect free so it is straightforward to
 * test under fast-check in subsequent property tests.
 */
export function toNativeGeofence(g: Geofence): NativeGeofence {
  if (g.geometry.kind === 'circle') {
    return {
      poiId: g.poiId,
      geometry: {
        kind: 'circle',
        center: g.geometry.center,
        radiusMeters: g.geometry.radiusMeters,
      },
      dwellSec: g.dwellSec,
    };
  }
  return {
    poiId: g.poiId,
    geometry: {
      kind: 'polygon',
      vertices: g.geometry.vertices,
    },
    dwellSec: g.dwellSec,
  };
}

/**
 * Shape `NativeEventEmitter`'s constructor expects for its
 * `nativeModule` argument. Re-stated here as a structural alias so we
 * can cast the turbo-module without dragging in the legacy
 * `NativeModule` type.
 */
interface NativeEventEmitterCompatibleModule {
  addListener: (eventType: string) => void;
  removeListeners: (count: number) => void;
}

/**
 * The shared `NativeEventEmitter` instance for the location module. Lazy
 * because instantiating eagerly at module load would require the native
 * side to be linked even in headless tests; we want consumers to be able
 * to mock the underlying turbo module before reaching the emitter.
 */
let _emitter: NativeEventEmitter | null = null;
function emitter(): NativeEventEmitter {
  if (_emitter === null) {
    // The cast routes the turbo module's codegen-required `addListener`
    // / `removeListeners` shims through to the emitter's bookkeeping;
    // the underlying object is structurally compatible.
    _emitter = new NativeEventEmitter(
      LocationService as unknown as NativeEventEmitterCompatibleModule,
    );
  }
  return _emitter;
}

// ---------------------------------------------------------------------------
// Public turbo-module surface
// ---------------------------------------------------------------------------

/**
 * Switch the native pipeline into a new operational mode. The engine
 * emits `RequestLocationMode` and the command translator (task 13.1)
 * forwards it through this function.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4.
 */
export function setMode(mode: LocationMode): void {
  // `LocationMode` and `NativeLocationMode` carry the same string set;
  // narrow the type explicitly for downstream readability.
  const nativeMode: NativeLocationMode = mode;
  LocationService.setMode(nativeMode);
}

/**
 * Replace the armed geofence set. The native side maintains the
 * 18-nearest sliding window itself; callers may safely pass the full
 * route's geofence list.
 *
 * Validates: Requirements 11.2, 12.2 (region monitoring),
 *            and the 20-region cap mitigation in design.md.
 */
export function armGeofences(geofences: ReadonlyArray<Geofence>): void {
  const native = geofences.map(toNativeGeofence);
  LocationService.armGeofences(native);
}

/**
 * Disarm all geofences and stop all location requests.
 *
 * Validates: Requirement 1.7.
 */
export function disarmAll(): void {
  LocationService.disarmAll();
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

function subscribe<P>(
  eventName: NativeLocationEventName,
  listener: (payload: P) => void,
): LocationSubscription {
  const subscription = emitter().addListener(eventName, listener);
  return {
    remove: () => subscription.remove(),
  };
}

/** Subscribe to `onAccepted`. */
export function onAccepted(
  listener: (payload: NativeAcceptedPayload) => void,
): LocationSubscription {
  return subscribe<NativeAcceptedPayload>('onAccepted', listener);
}

/** Subscribe to `onRejected`. */
export function onRejected(
  listener: (payload: NativeRejectedPayload) => void,
): LocationSubscription {
  return subscribe<NativeRejectedPayload>('onRejected', listener);
}

/** Subscribe to `onGeofenceEnter`. */
export function onGeofenceEnter(
  listener: (payload: NativeGeofencePayload) => void,
): LocationSubscription {
  return subscribe<NativeGeofencePayload>('onGeofenceEnter', listener);
}

/** Subscribe to `onGeofenceDwell`. */
export function onGeofenceDwell(
  listener: (payload: NativeGeofencePayload) => void,
): LocationSubscription {
  return subscribe<NativeGeofencePayload>('onGeofenceDwell', listener);
}

/** Subscribe to `onGeofenceExit`. */
export function onGeofenceExit(
  listener: (payload: NativeGeofencePayload) => void,
): LocationSubscription {
  return subscribe<NativeGeofencePayload>('onGeofenceExit', listener);
}

/**
 * Subscribe to `onAccuracyChanged`. The UI binds the
 * user-visible high-accuracy indicator (Req 11.5) to this event by
 * reading the `highAccuracy` field of each payload.
 *
 * Validates: Requirement 11.5.
 */
export function onAccuracyChanged(
  listener: (payload: NativeAccuracyChangedPayload) => void,
): LocationSubscription {
  return subscribe<NativeAccuracyChangedPayload>('onAccuracyChanged', listener);
}

/**
 * Reset the cached `NativeEventEmitter`. Tests use this to swap in a
 * fresh emitter after re-mocking the underlying turbo module. NOT
 * intended for production code paths.
 */
export function __resetEmitterForTests(): void {
  _emitter = null;
}
