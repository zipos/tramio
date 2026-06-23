/**
 * OfflineMap — React Native component wrapping MapLibre GL Native with
 * offline vector tiles served from Storage_Manager.
 *
 * This component:
 * - Renders maps using MapLibre GL Native (Req 4.1)
 * - Serves tiles from `${docs}/packs/{bundleId}/{version}/tiles/` (Req 3.2)
 * - Issues NO outbound tile requests during an active tour (Req 3.2)
 * - Has NO dependency on Google Maps Platform, Apple MapKit, or Mapbox
 *   commercial tiles (Req 4.4)
 *
 * The tile source is a local file:// URL pointing to pre-downloaded .pbf
 * vector tiles in the Offline_Pack. Tiles are NOT encrypted (Req 21.2)
 * since the underlying OpenStreetMap data is publicly licensed.
 *
 * @see design.md "### Storage_Manager"
 * @see design.md "## Data Models > Authoring_Schema" (tiles/ directory)
 * @see Requirements 3.2, 4.1, 4.4
 */

import React, { useMemo, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import MapLibreGL from '@maplibre/maplibre-react-native';

import type { OfflineMapProps } from './types';
import { resolveOfflineTileSource, buildOfflineStyle } from './tileSource';

// Initialize MapLibre without an API key — we use no commercial tile service.
// This call is idempotent and safe to invoke at module load time.
MapLibreGL.setAccessToken(null);

/**
 * OfflineMap renders a MapLibre GL Native map view configured to serve
 * vector tiles exclusively from the local Offline_Pack store.
 *
 * No network requests are made for tile data. The component accepts a
 * `tilePack` prop (bundleId + version) and a `docsDir` prop to resolve
 * the correct tile path on disk.
 *
 * @example
 * ```tsx
 * <OfflineMap
 *   tilePack={{ bundleId: 'wroclaw-tram-7-east', version: '1.4.2' }}
 *   docsDir={FileSystem.documentDirectory}
 *   initialCenter={[51.11, 17.03]}
 *   initialZoom={14}
 * />
 * ```
 */
export function OfflineMap({
  tilePack,
  docsDir,
  style,
  initialCenter,
  initialZoom = 14,
  tourActive = true,
  onMapReady,
}: OfflineMapProps): React.JSX.Element {
  // Resolve the offline tile source URL from the pack reference.
  const tileSource = useMemo(
    () => resolveOfflineTileSource(docsDir, tilePack),
    [docsDir, tilePack.bundleId, tilePack.version],
  );

  // Build the MapLibre style JSON with the offline tile source.
  // When tourActive is true (default), this is the ONLY source —
  // no network fallback, no outbound requests (Req 3.2).
  const mapStyle = useMemo(() => {
    if (!tileSource.valid) {
      // Return a minimal empty style if the tile source is invalid.
      return { version: 8, sources: {}, layers: [] };
    }
    return buildOfflineStyle(tileSource.tileUrl);
  }, [tileSource]);

  const handleMapReady = useCallback(() => {
    onMapReady?.();
  }, [onMapReady]);

  // Convert [lat, lng] to MapLibre's [lng, lat] format.
  const centerCoordinate = useMemo((): [number, number] | null => {
    if (!initialCenter) return null;
    return [initialCenter[1], initialCenter[0]];
  }, [initialCenter]);

  // Build camera default settings, only including centerCoordinate when defined.
  const cameraDefaults = useMemo(() => {
    const defaults: { zoomLevel: number; centerCoordinate?: [number, number] } = {
      zoomLevel: initialZoom,
    };
    if (centerCoordinate) {
      defaults.centerCoordinate = centerCoordinate;
    }
    return defaults;
  }, [centerCoordinate, initialZoom]);

  return (
    <View
      style={[styles.container, style]}
      accessibilityRole="image"
      accessibilityLabel="Offline map view"
    >
      <MapLibreGL.MapView
        style={styles.map}
        styleJSON={JSON.stringify(mapStyle)}
        logoEnabled={false}
        attributionEnabled={false}
        // Disable telemetry — no outbound requests (Req 3.2)
        telemetryEnabled={false}
        onDidFinishLoadingMap={handleMapReady}
      >
        <MapLibreGL.Camera defaultSettings={cameraDefaults} />
      </MapLibreGL.MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
});
