// Primitive runtime types shared across the Tour_Engine reducer.
//
// These match the "Data Models > Runtime types (TypeScript)" block in
// .kiro/specs/urban-narrative-mvp/design.md verbatim, plus `LocationMode`
// which is defined inline by the Location_Service section of the same
// document.

/** A `[latitude, longitude]` pair in decimal degrees. */
export type LatLng = readonly [number, number];

/**
 * A geofence anchored to a POI on the active route.
 *
 * @see design.md "Data Models > Runtime types (TypeScript)"
 * @see Requirements 1.1, 1.6, 5.5
 */
export interface Geofence {
  poiId: string;
  geometry:
    | { kind: 'circle'; center: LatLng; radiusMeters: number }
    | { kind: 'polygon'; vertices: LatLng[] };
  directionFilter?: { kind: 'alongRoute'; toleranceDeg: number };
  dwellSec: number;
  /**
   * Authored priority. Higher numeric value = more important.
   * Used by the priority comparator to resolve overlapping triggers (Req 1.6).
   */
  priority: number;
  /**
   * Zero-based index of this POI in the authored pois.json array.
   * Used as a tie-breaker when priorities are equal: lower index wins (Req 1.6).
   */
  authorIndex: number;
}

/**
 * A raw, OS-delivered location update before the JS-side pipeline has
 * smoothed it or projected it onto the active route.
 */
export interface PositionUpdate {
  /** ms since epoch */
  ts: number;
  coord: LatLng;
  accuracyM: number;
  speedMps?: number;
  headingDeg?: number;
}

/**
 * A `PositionUpdate` that has cleared the accuracy gate, the spike
 * rejection filter, and the EMA smoothing window. Carries the smoothed
 * coordinate plus the monotonic projection on the active route.
 *
 * @see design.md "Geofence Filtering Pipeline"
 * @see Requirement 5.5
 */
export interface AcceptedUpdate extends PositionUpdate {
  smoothed: LatLng;
  /** monotonic projection on active route */
  alongRouteM: number;
}

/**
 * Entitlement tier ladder used to filter narrative segments during dispatch.
 *
 * @see Requirement 14.2
 */
export type EntitlementTier = 'free' | 'time_pass' | 'token_unlock' | 'b2b';

/**
 * A single entitlement grant. Scope narrows the grant to a bundle, POI, or
 * deeper layer; absence of scope means the grant applies broadly.
 */
export interface Entitlement {
  tier: EntitlementTier;
  scope?: { bundleId?: string; poiId?: string; layerId?: string };
  /** UTC ms; absence means no expiry. */
  expiryUtc?: number;
}

/**
 * Location_Service operational mode requested by the engine via
 * `RequestLocationMode`. The translator forwards this to the native
 * turbo module's `setMode(...)`.
 *
 * @see design.md "Location_Service (native turbo module)"
 * @see Requirement 15.1
 */
export type LocationMode = 'idle' | 'standby' | 'tour-bg' | 'tour-approach' | 'reconcile';
