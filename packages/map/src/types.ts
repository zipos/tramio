/**
 * Types for the @tramio/map package.
 *
 * The map layer renders MapLibre GL Native with offline vector tiles
 * served from Storage_Manager's pack store. No outbound tile requests
 * are issued during an active tour (Req 3.2). No dependency on Google
 * Maps Platform, Apple MapKit, or Mapbox commercial tiles (Req 4.4).
 *
 * @see design.md "### Storage_Manager"
 * @see Requirements 3.2, 4.1, 4.4
 */

import type { ViewStyle } from 'react-native';

/**
 * Identifies the offline tile pack to use. Resolves to the tile
 * directory at `${docs}/packs/{bundleId}/{version}/tiles/`.
 */
export interface TilePackRef {
  /** The Content_Bundle identifier (e.g. "wroclaw-tram-7-east"). */
  bundleId: string;
  /** The Content_Bundle version (e.g. "1.4.2"). */
  version: string;
}

/**
 * Props for the OfflineMap component.
 */
export interface OfflineMapProps {
  /** Identifies which offline tile pack to serve tiles from. */
  tilePack: TilePackRef;

  /**
   * Absolute path to the platform documents directory.
   * On React Native this is typically `FileSystem.documentDirectory`.
   * The tile source resolves to `${docsDir}/packs/{bundleId}/{version}/tiles/`.
   */
  docsDir: string;

  /** Optional style applied to the map container view. */
  style?: ViewStyle;

  /** Initial center coordinate [latitude, longitude]. */
  initialCenter?: readonly [number, number];

  /** Initial zoom level (0–22). Defaults to 14. */
  initialZoom?: number;

  /**
   * Whether the map is in tour-active mode. When true, the tile source
   * is strictly offline (no network fallback). Defaults to true.
   */
  tourActive?: boolean;

  /** Called when the map finishes loading. */
  onMapReady?: () => void;
}

/**
 * Result of resolving a tile pack to a local file:// URL for MapLibre.
 */
export interface ResolvedTileSource {
  /** The file:// URL pointing to the tile directory's template path. */
  tileUrl: string;
  /** Whether the source is valid (directory path is well-formed). */
  valid: boolean;
}
