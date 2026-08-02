/**
 * OfflineMap — React Native component wrapping MapLibre GL Native with
 * offline vector tiles served from Storage_Manager.
 *
 * Overlays (route polyline, POI markers, user position) are rendered as
 * GeoJSON ShapeSources so the ride UI stays useful even when corridor tiles
 * are sparse. OSM attribution is a static in-app label (no network).
 *
 * @see Requirements 3.2, 4.1, 4.4
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';

import type { OfflineMapProps } from './types';
import { resolveOfflineTileSource, buildOfflineStyle } from './tileSource';
import { poisToFeatureCollection, positionToPointFeature, routeToLineStringFeature } from './geo';

MapLibreGL.setAccessToken(null);

const ROUTE_COLOR = '#1e3a5f';
const POI_AHEAD_COLOR = '#2563eb';
const POI_NEXT_COLOR = '#c2410c';
const POI_DONE_COLOR = '#9ca3af';
const USER_COLOR = '#b91c1c';

const routeLineStyle = {
  lineColor: ROUTE_COLOR,
  lineWidth: 4,
  lineOpacity: 0.9,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
};

const poiDoneStyle = {
  circleRadius: 5,
  circleColor: POI_DONE_COLOR,
  circleOpacity: 0.75,
  circleStrokeWidth: 1,
  circleStrokeColor: '#ffffff',
};

const poiAheadStyle = {
  circleRadius: 6,
  circleColor: POI_AHEAD_COLOR,
  circleOpacity: 0.9,
  circleStrokeWidth: 1.5,
  circleStrokeColor: '#ffffff',
};

const poiNextStyle = {
  circleRadius: 8,
  circleColor: POI_NEXT_COLOR,
  circleOpacity: 1,
  circleStrokeWidth: 2,
  circleStrokeColor: '#ffffff',
};

const userHaloStyle = {
  circleRadius: 14,
  circleColor: USER_COLOR,
  circleOpacity: 0.2,
};

const userDotStyle = {
  circleRadius: 7,
  circleColor: USER_COLOR,
  circleStrokeWidth: 2,
  circleStrokeColor: '#ffffff',
};

/**
 * OfflineMap renders a MapLibre GL Native map view configured to serve
 * vector tiles exclusively from the local Offline_Pack store, plus tour
 * overlays for route / POIs / rider position.
 */
export function OfflineMap({
  tilePack,
  docsDir,
  style,
  initialCenter,
  initialZoom = 14,
  tourActive = true,
  onMapReady,
  route,
  pois,
  userPosition,
}: OfflineMapProps): React.JSX.Element {
  const { bundleId, version } = tilePack;
  const [followUser, setFollowUser] = useState(true);
  const hadUserPosition = React.useRef(false);

  const tileSource = useMemo(
    () => resolveOfflineTileSource(docsDir, { bundleId, version }),
    [docsDir, bundleId, version],
  );

  const mapStyle = useMemo(() => {
    if (!tileSource.valid) {
      return { version: 8, sources: {}, layers: [] };
    }
    return buildOfflineStyle(tileSource.tileUrl);
  }, [tileSource]);

  const handleMapReady = useCallback(() => {
    onMapReady?.();
  }, [onMapReady]);

  const centerCoordinate = useMemo((): [number, number] | null => {
    if (followUser && userPosition) {
      return [userPosition[1], userPosition[0]];
    }
    if (initialCenter) {
      return [initialCenter[1], initialCenter[0]];
    }
    if (userPosition) {
      return [userPosition[1], userPosition[0]];
    }
    return null;
  }, [followUser, userPosition, initialCenter]);

  // Re-enable follow when a tour first gains a fix.
  useEffect(() => {
    if (userPosition && !hadUserPosition.current) {
      hadUserPosition.current = true;
      setFollowUser(true);
    }
    if (!userPosition) {
      hadUserPosition.current = false;
    }
  }, [userPosition]);

  const cameraDefaults = useMemo(() => {
    const defaults: { zoomLevel: number; centerCoordinate?: [number, number] } = {
      zoomLevel: initialZoom,
    };
    if (centerCoordinate) {
      defaults.centerCoordinate = centerCoordinate;
    }
    return defaults;
  }, [centerCoordinate, initialZoom]);

  const routeShape = useMemo(() => {
    if (!route || route.length < 2) return null;
    return routeToLineStringFeature(route);
  }, [route]);

  const poisShape = useMemo(() => {
    if (!pois || pois.length === 0) return null;
    return poisToFeatureCollection(pois);
  }, [pois]);

  const userShape = useMemo(() => {
    if (!userPosition) return null;
    return positionToPointFeature(userPosition);
  }, [userPosition]);

  const handleRegionDidChange = useCallback(
    (feature: GeoJSON.Feature<GeoJSON.Point, { isUserInteraction?: boolean }>) => {
      if (feature.properties?.isUserInteraction === true) {
        setFollowUser(false);
      }
    },
    [],
  );

  const showRecenter = userPosition != null && !followUser;

  return (
    <View
      style={[styles.container, style]}
      accessibilityRole="image"
      accessibilityLabel={tourActive ? 'Offline map view' : 'Map view'}
    >
      <MapLibreGL.MapView
        style={styles.map}
        mapStyle={mapStyle}
        logoEnabled={false}
        // Built-in attribution can open network links; use static overlay instead.
        attributionEnabled={false}
        compassEnabled={false}
        onDidFinishLoadingMap={handleMapReady}
        onRegionDidChange={handleRegionDidChange}
      >
        <MapLibreGL.Camera
          defaultSettings={cameraDefaults}
          {...(followUser && centerCoordinate
            ? {
                centerCoordinate,
                zoomLevel: initialZoom,
                animationDuration: 400,
                animationMode: 'easeTo',
              }
            : {})}
        />

        {routeShape ? (
          <MapLibreGL.ShapeSource id="tramio-route" shape={routeShape}>
            <MapLibreGL.LineLayer id="tramio-route-line" style={routeLineStyle} />
          </MapLibreGL.ShapeSource>
        ) : null}

        {poisShape ? (
          <MapLibreGL.ShapeSource id="tramio-pois" shape={poisShape}>
            <MapLibreGL.CircleLayer
              id="tramio-pois-done"
              filter={['==', ['get', 'consumed'], 1]}
              style={poiDoneStyle}
            />
            <MapLibreGL.CircleLayer
              id="tramio-pois-ahead"
              filter={['all', ['!=', ['get', 'consumed'], 1], ['!=', ['get', 'highlight'], 1]]}
              style={poiAheadStyle}
            />
            <MapLibreGL.CircleLayer
              id="tramio-pois-next"
              filter={['==', ['get', 'highlight'], 1]}
              style={poiNextStyle}
            />
          </MapLibreGL.ShapeSource>
        ) : null}

        {userShape ? (
          <MapLibreGL.ShapeSource id="tramio-user" shape={userShape}>
            <MapLibreGL.CircleLayer id="tramio-user-halo" style={userHaloStyle} />
            <MapLibreGL.CircleLayer id="tramio-user-dot" style={userDotStyle} />
          </MapLibreGL.ShapeSource>
        ) : null}
      </MapLibreGL.MapView>

      {showRecenter ? (
        <TouchableOpacity
          style={styles.recenterButton}
          onPress={() => setFollowUser(true)}
          accessibilityRole="button"
          accessibilityLabel="Recenter map on your position"
        >
          <Text style={styles.recenterText}>Recenter</Text>
        </TouchableOpacity>
      ) : null}

      {/* Static OSM attribution — no outbound requests (Req 3.2 / 4.x). */}
      <View
        style={styles.attribution}
        pointerEvents="none"
        accessibilityLabel="Map data from OpenStreetMap contributors"
      >
        <Text style={styles.attributionText}>© OpenStreetMap</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: '#f8f4f0',
  },
  map: {
    flex: 1,
  },
  recenterButton: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: '#1e3a5f',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    minHeight: 36,
    justifyContent: 'center',
  },
  recenterText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  attribution: {
    position: 'absolute',
    right: 8,
    bottom: 6,
    backgroundColor: 'rgba(255,255,255,0.82)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  attributionText: {
    fontSize: 10,
    color: '#4b5563',
  },
});
