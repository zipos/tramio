/**
 * Geospatial utilities for the @tramio/map package.
 *
 * Handles the coordinate order conversion between the engine's [lat, lon]
 * format and GeoJSON's [lon, lat] format. This is a common source of bugs:
 * getting it backwards places geometry in the Indian Ocean.
 *
 * @see RFC 7946 §3.1.1 — GeoJSON positions are [longitude, latitude].
 */

/**
 * Converts a single [lat, lon] coordinate (engine format) to
 * [lon, lat] (GeoJSON format).
 */
export function latLonToGeoJSON(coord: readonly [number, number]): [number, number] {
  return [coord[1], coord[0]];
}

/**
 * Converts an array of [lat, lon] coordinates (engine format) to an
 * array of [lon, lat] coordinates (GeoJSON format).
 */
export function routeToGeoJSONCoordinates(
  route: readonly (readonly [number, number])[],
): [number, number][] {
  return route.map((c) => latLonToGeoJSON(c));
}

/**
 * Builds a GeoJSON LineString feature from an engine-format route.
 */
export function routeToLineStringFeature(
  route: readonly (readonly [number, number])[],
): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: routeToGeoJSONCoordinates(route),
    },
  };
}

/**
 * Builds a GeoJSON Point feature from an engine-format [lat, lon] position.
 */
export function positionToPointFeature(
  position: readonly [number, number],
  properties: Record<string, unknown> = {},
): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: 'Feature',
    properties,
    geometry: {
      type: 'Point',
      coordinates: latLonToGeoJSON(position),
    },
  };
}

export interface PoiGeoInput {
  readonly poiId: string;
  readonly center: readonly [number, number];
  readonly radiusMeters: number;
  readonly consumed?: boolean;
  readonly highlight?: boolean;
}

/**
 * Builds a FeatureCollection of POI points for CircleLayer rendering.
 */
export function poisToFeatureCollection(
  pois: readonly PoiGeoInput[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: pois.map((poi) =>
      positionToPointFeature(poi.center, {
        poiId: poi.poiId,
        radiusMeters: poi.radiusMeters,
        consumed: poi.consumed === true ? 1 : 0,
        highlight: poi.highlight === true ? 1 : 0,
      }),
    ),
  };
}
