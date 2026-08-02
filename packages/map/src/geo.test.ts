import {
  latLonToGeoJSON,
  poisToFeatureCollection,
  positionToPointFeature,
  routeToLineStringFeature,
} from './geo';

describe('map geo helpers', () => {
  it('converts lat/lon to GeoJSON lon/lat', () => {
    expect(latLonToGeoJSON([52.23, 21.01])).toEqual([21.01, 52.23]);
  });

  it('builds a LineString from an engine route', () => {
    const feature = routeToLineStringFeature([
      [52.23, 21.01],
      [52.24, 21.02],
    ]);
    expect(feature.geometry.type).toBe('LineString');
    expect(feature.geometry.coordinates).toEqual([
      [21.01, 52.23],
      [21.02, 52.24],
    ]);
  });

  it('builds POI FeatureCollection with consumed/highlight flags', () => {
    const fc = poisToFeatureCollection([
      { poiId: 'a', center: [52.23, 21.01], radiusMeters: 40, highlight: true },
      { poiId: 'b', center: [52.24, 21.02], radiusMeters: 50, consumed: true },
    ]);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0]!.properties).toMatchObject({
      poiId: 'a',
      highlight: 1,
      consumed: 0,
    });
    expect(fc.features[1]!.properties).toMatchObject({
      poiId: 'b',
      highlight: 0,
      consumed: 1,
    });
    expect(fc.features[0]!.geometry.coordinates).toEqual([21.01, 52.23]);
  });

  it('builds a user Point feature', () => {
    const point = positionToPointFeature([52.23, 21.01], { kind: 'user' });
    expect(point.geometry.coordinates).toEqual([21.01, 52.23]);
    expect(point.properties).toEqual({ kind: 'user' });
  });
});
