/**
 * TurboModule codegen spec for the native Location_Service module.
 *
 * This file is consumed by React Native's codegen to generate the native
 * stubs (`NativeLocationServiceSpec` on iOS, the JSI bridge on Android).
 * It deliberately uses only codegen-compatible types: primitives, arrays,
 * and a single nominal `Object` for the geofence payload because the
 * codegen does not support TypeScript discriminated unions for input
 * parameters in the current React Native version (0.81). The native side
 * is responsible for normalizing the structurally typed `Object`s into
 * the strongly typed `NativeGeofence` shape expected by `CLLocationManager`
 * / `GeofencingClient`.
 *
 * Events (`onAccepted`, `onRejected`, `onGeofenceEnter`, `onGeofenceDwell`,
 * `onGeofenceExit`, `onAccuracyChanged`) are delivered through React
 * Native's standard event-emitter machinery; the `addListener` /
 * `removeListeners` shims below are the codegen-required hooks the bridge
 * uses to track listener counts. Consumers DO NOT call those directly —
 * they instantiate `NativeEventEmitter(LocationService)` and subscribe via
 * the typed wrappers exported from `./index.ts`.
 *
 * Validates: Requirements 5.1, 5.2, 11.1, 11.2, 11.3, 11.4, 11.5, 12.2,
 *            12.3, 15.1
 *
 * @see design.md "Components and Interfaces > Location_Service (native turbo module)"
 */

import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Operational mode for the native location pipeline. Values are kept as
 * literal strings (rather than a numeric enum) so the codegen-generated
 * native interface accepts any future-added mode without breaking the
 * native ABI. The TS-side wrapper in `./index.ts` narrows this to the
 * engine's `LocationMode` discriminator.
 */
export type NativeLocationMode = 'idle' | 'standby' | 'tour-bg' | 'tour-approach' | 'reconcile';

/**
 * The shape `armGeofences(...)` expects for each entry. Declared as an
 * `Object` in the {@link Spec} signature because the codegen does not yet
 * support discriminated-union inputs; this interface documents the actual
 * runtime payload that the wrapper sends and the native side parses.
 *
 * Coordinates are `[latitude, longitude]` decimal degrees.
 */
export interface NativeGeofence {
  poiId: string;
  geometry:
    | {
        kind: 'circle';
        center: readonly [number, number];
        radiusMeters: number;
      }
    | {
        kind: 'polygon';
        vertices: ReadonlyArray<readonly [number, number]>;
      };
  /** Seconds the user must dwell inside the region before the JS dwell stage fires. */
  dwellSec: number;
}

/**
 * Payload emitted with `onAccepted`. Mirrors the engine's
 * `PositionUpdate` plus a `mode` echo so JS subscribers can correlate
 * the update with the location mode active when it was produced.
 */
export interface NativeAcceptedPayload {
  /** ms since epoch */
  ts: number;
  coord: readonly [number, number];
  accuracyM: number;
  speedMps?: number;
  headingDeg?: number;
  /** Echo of the mode the native pipeline was in when the fix was accepted. */
  mode: NativeLocationMode;
}

/** Payload emitted with `onRejected`. */
export interface NativeRejectedPayload {
  reason: 'accuracy' | 'spike' | 'duplicate';
  ts: number;
  coord: readonly [number, number];
  accuracyM: number;
}

/** Payload emitted with `onGeofenceEnter` / `onGeofenceDwell` / `onGeofenceExit`. */
export interface NativeGeofencePayload {
  poiId: string;
  /** ms since epoch */
  ts: number;
}

/**
 * Payload emitted with `onAccuracyChanged`. `highAccuracy` is true iff
 * the native side is currently consuming high-power location updates;
 * the UI uses this to drive the user-visible high-accuracy indicator
 * (Req 11.5).
 */
export interface NativeAccuracyChangedPayload {
  highAccuracy: boolean;
  mode: NativeLocationMode;
}

/**
 * The raw native event names. The order MUST match the names registered
 * by the iOS/Android implementations and is exposed as
 * `LOCATION_SERVICE_EVENTS` from `./index.ts` so JS callers stay in sync
 * with native.
 *
 * Validates: Requirement 15.1 (turbo-module wrapping).
 */
export const NATIVE_LOCATION_EVENT_NAMES = [
  'onAccepted',
  'onRejected',
  'onGeofenceEnter',
  'onGeofenceDwell',
  'onGeofenceExit',
  'onAccuracyChanged',
] as const;

export type NativeLocationEventName = (typeof NATIVE_LOCATION_EVENT_NAMES)[number];

/**
 * The TurboModule contract. Method names map 1-to-1 to the iOS
 * `RCT_EXPORT_METHOD` declarations and the Android `@ReactMethod`
 * annotations.
 *
 * Per RN codegen conventions, the spec interface MUST be named `Spec`
 * for the codegen tool to pick it up.
 */
export interface Spec extends TurboModule {
  /**
   * Switch the native pipeline into a new operational mode. Synchronous;
   * the call returns once the mode is committed at the OS layer (e.g.
   * `CLLocationManager.startUpdatingLocation` invoked).
   *
   * Validates: Requirements 11.1, 11.2, 11.3, 11.4.
   */
  setMode(mode: string): void;

  /**
   * Replace the currently armed geofence set with `geofences` (or the
   * 18-nearest sliding window the native side actually arms; see
   * design.md "iOS region monitoring limited to 20 active regions"). The
   * native implementation maintains the sliding window as accepted
   * updates arrive, so callers may pass the full route's geofence list.
   *
   * The argument is typed as `ReadonlyArray<Object>` (capital `O`)
   * because React Native's TurboModule codegen does not yet support
   * discriminated-union inputs, only the wide-Object placeholder. The
   * wrapper in `./index.ts` translates `Geofence` values into the
   * runtime shape documented by {@link NativeGeofence}.
   *
   * Validates: Requirements 11.2, 12.2.
   */
  // eslint-disable-next-line @typescript-eslint/ban-types -- RN codegen requires capital `Object` for object payloads in spec files.
  armGeofences(geofences: ReadonlyArray<Object>): void;

  /**
   * Disarm all geofences and stop all location requests. Used on
   * `ReleaseAll`, route deviation prompt timeout, or tour end.
   *
   * Validates: Requirement 1.7 (release within 2 s).
   */
  disarmAll(): void;

  /**
   * RN codegen-required hook. Increments the native listener count for
   * `eventName`. Consumers go through `NativeEventEmitter`, not this
   * method; it is part of the spec only because codegen demands it.
   */
  addListener(eventName: string): void;

  /**
   * RN codegen-required hook. Decrements the native listener count by
   * `count`. Consumers go through `NativeEventEmitter`, not this method.
   */
  removeListeners(count: number): void;
}

/**
 * The registered name of the native module. MUST match the
 * `RCT_EXPORT_MODULE` name on iOS and the `@ReactModule(name = ...)`
 * annotation on Android.
 */
export const TRAMIO_LOCATION_SERVICE_MODULE_NAME = 'TramioLocationService' as const;

/**
 * Resolve the native module instance. Throws synchronously if the native
 * module is not linked, which is the desired behavior — running on a
 * platform without the module wired up indicates a build-configuration
 * bug, not a runtime fallback case.
 */
export default TurboModuleRegistry.getEnforcing<Spec>(TRAMIO_LOCATION_SERVICE_MODULE_NAME);
