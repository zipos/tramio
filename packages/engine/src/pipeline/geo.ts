// Geodetic helpers for the geofence filtering pipeline.
//
// All distances are in meters, all angles in degrees. The Earth is treated
// as a sphere of mean radius 6,371,000 m; this is the same approximation
// CoreLocation and FusedLocationProvider use internally for their distance
// helpers, so the filter thresholds in design.md (50 m accuracy gate,
// 120 km/h spike, 150 m deviation corridor) are interpreted in the same
// units the OS reports.
//
// @see design.md "Geofence Filtering Pipeline"

import type { LatLng } from '../types';

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/**
 * Great-circle distance between two `LatLng` points, in meters.
 *
 * @see Requirement 5.2 (spike rejection compares haversine distance / dt)
 */
export function haversine(a: LatLng, b: LatLng): number {
  const [lat1, lon1] = a;
  const [lat2, lon2] = b;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLam = toRad(lon2 - lon1);
  const sinHalfDPhi = Math.sin(dPhi / 2);
  const sinHalfDLam = Math.sin(dLam / 2);
  const h = sinHalfDPhi * sinHalfDPhi + Math.cos(phi1) * Math.cos(phi2) * sinHalfDLam * sinHalfDLam;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
  return EARTH_RADIUS_M * c;
}

/**
 * Initial bearing (forward azimuth) from `a` to `b`, normalized to [0, 360).
 * Used by Stage 5 (direction filter) to compare a user's heading against the
 * route tangent at the projection point.
 */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const phi1 = toRad(a[0]);
  const phi2 = toRad(b[0]);
  const dLam = toRad(b[1] - a[1]);
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Smallest absolute angular difference between two bearings, in [0, 180].
 * Wraps modulo 360 so `angularDiffDeg(355, 5) === 10`.
 */
export function angularDiffDeg(a: number, b: number): number {
  const diff = (((a - b) % 360) + 360) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** Result of projecting a coordinate onto the polyline. */
export interface RouteProjection {
  /** Distance along the polyline from its start to the projected point, in meters. */
  readonly alongRouteM: number;
  /** Bearing of the polyline segment containing the projection (start->end of that segment), in degrees. */
  readonly tangentDeg: number;
}

/**
 * Project a coordinate onto a polyline. Returns the along-route distance
 * (cumulative segment lengths up to the projected point) and the tangent
 * bearing of the containing segment.
 *
 * The polyline is parameterized in traversal order, so `alongRouteM` is
 * monotonic in the polyline's own arc-length parameter: any point that
 * projects onto a later segment has a strictly greater `alongRouteM` than
 * any point that projects strictly inside an earlier segment.
 *
 * For self-intersecting polylines, the closest segment in planar
 * approximation wins. We use a small ENU-style projection (east/north
 * meters relative to the segment start) for the per-segment dot product;
 * for the segment lengths in the output we still use haversine so the
 * answer matches the OS-reported distances.
 *
 * Throws if `route.length < 2`.
 *
 * @see Requirement 5.5 (smoothed projection used by Tour_Engine)
 */
export function projectOnRoute(route: readonly LatLng[], coord: LatLng): RouteProjection {
  if (route.length < 2) {
    throw new Error('projectOnRoute: route must have at least 2 vertices');
  }

  // Pre-compute haversine segment lengths once.
  const segLengthsM: number[] = new Array(route.length - 1);
  for (let i = 0; i < route.length - 1; i++) {
    segLengthsM[i] = haversine(route[i] as LatLng, route[i + 1] as LatLng);
  }

  let bestSegIdx = 0;
  let bestT = 0;
  let bestDistSq = Infinity;

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i] as LatLng;
    const b = route[i + 1] as LatLng;
    // Local ENU around `a`, in meters. Latitude has constant scale; longitude
    // scales by cos(lat). Good to within tens of cm for sub-km segments.
    const phi0 = toRad(a[0]);
    const mPerDegLat = (Math.PI * EARTH_RADIUS_M) / 180;
    const mPerDegLon = mPerDegLat * Math.cos(phi0);
    const bE = (b[1] - a[1]) * mPerDegLon;
    const bN = (b[0] - a[0]) * mPerDegLat;
    const cE = (coord[1] - a[1]) * mPerDegLon;
    const cN = (coord[0] - a[0]) * mPerDegLat;
    const segLenSq = bE * bE + bN * bN;

    let t: number;
    if (segLenSq === 0) {
      t = 0;
    } else {
      t = (cE * bE + cN * bN) / segLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const projE = t * bE;
    const projN = t * bN;
    const dE = cE - projE;
    const dN = cN - projN;
    const distSq = dE * dE + dN * dN;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestSegIdx = i;
      bestT = t;
    }
  }

  let cum = 0;
  for (let i = 0; i < bestSegIdx; i++) cum += segLengthsM[i] as number;
  cum += bestT * (segLengthsM[bestSegIdx] as number);
  const tangentDeg = bearingDeg(route[bestSegIdx] as LatLng, route[bestSegIdx + 1] as LatLng);
  return { alongRouteM: cum, tangentDeg };
}

/**
 * Test whether a coordinate falls inside a circular geofence. Distance is
 * measured by haversine and compared against the geofence radius.
 */
export function pointInCircle(coord: LatLng, center: LatLng, radiusMeters: number): boolean {
  return haversine(center, coord) <= radiusMeters;
}

/**
 * Standard even-odd ray-casting in (lat, lon) space. Adequate for the small
 * urban-scale polygons authoring is expected to produce; for larger or more
 * complex shapes we would want a proper spherical-polygon test, but the
 * authoring schema constrains polygons to the route corridor.
 */
export function pointInPolygon(vertices: readonly LatLng[], coord: LatLng): boolean {
  if (vertices.length < 3) return false;
  const [lat, lon] = coord;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const vi = vertices[i] as LatLng;
    const vj = vertices[j] as LatLng;
    const latI = vi[0];
    const lonI = vi[1];
    const latJ = vj[0];
    const lonJ = vj[1];
    const intersect =
      latI > lat !== latJ > lat && lon < ((lonJ - lonI) * (lat - latI)) / (latJ - latI) + lonI;
    if (intersect) inside = !inside;
  }
  return inside;
}
