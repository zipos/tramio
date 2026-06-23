/**
 * Offline tile source resolver for MapLibre GL Native.
 *
 * Resolves a TilePackRef to a local file:// URL template that MapLibre
 * can consume as a vector tile source. The tiles live at:
 *   `${docsDir}/packs/{bundleId}/{version}/tiles/{z}/{x}/{y}.pbf`
 *
 * This module is intentionally string-only (no filesystem I/O) so it
 * is trivially testable and reusable from both production wiring and
 * unit tests.
 *
 * No outbound tile requests are issued — MapLibre is configured with
 * a local file:// source only (Req 3.2). Tiles are NOT encrypted per
 * design.md (Req 21.2) since the underlying OpenStreetMap data is
 * publicly licensed.
 *
 * @see design.md "### Storage_Manager"
 * @see design.md "## Data Models > Authoring_Schema" (tiles/ directory)
 * @see Requirements 3.2, 4.1, 4.4, 21.2
 */

import type { TilePackRef, ResolvedTileSource } from './types';

/**
 * Characters that are forbidden in bundleId or version segments.
 * Mirrors the validation in @tramio/storage paths module.
 */
const BAD_SEGMENT = /[/\\]/u;

/**
 * Validates that a segment is safe for use in a filesystem path.
 * Returns true if the segment is non-empty and contains no path
 * separators or traversal patterns.
 */
function isSafeSegment(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (BAD_SEGMENT.test(value)) return false;
  if (value === '.' || value === '..' || value.includes('\u0000')) return false;
  return true;
}

/**
 * Resolves a tile pack reference to a local file:// URL template for
 * MapLibre's vector tile source.
 *
 * The returned URL uses MapLibre's `{z}/{x}/{y}` template placeholders
 * so the renderer can request individual tiles by zoom/column/row.
 *
 * @param docsDir - Absolute path to the platform documents directory.
 * @param tilePack - The bundle identifier and version to resolve.
 * @returns A ResolvedTileSource with the file:// URL template, or
 *          `valid: false` if the inputs are malformed.
 *
 * @example
 * ```ts
 * const source = resolveOfflineTileSource('/data/docs', {
 *   bundleId: 'wroclaw-tram-7-east',
 *   version: '1.4.2',
 * });
 * // source.tileUrl === 'file:///data/docs/packs/wroclaw-tram-7-east/1.4.2/tiles/{z}/{x}/{y}.pbf'
 * ```
 */
export function resolveOfflineTileSource(
  docsDir: string,
  tilePack: TilePackRef,
): ResolvedTileSource {
  if (!docsDir || typeof docsDir !== 'string') {
    return { tileUrl: '', valid: false };
  }

  if (!isSafeSegment(tilePack.bundleId) || !isSafeSegment(tilePack.version)) {
    return { tileUrl: '', valid: false };
  }

  // Normalize: strip trailing slash from docsDir for consistent joining.
  const normalizedDocs = docsDir.replace(/\/+$/, '');

  // Build the tile URL template.
  // MapLibre expects `{z}/{x}/{y}` placeholders in the tile URL.
  const tileUrl = `file://${normalizedDocs}/packs/${tilePack.bundleId}/${tilePack.version}/tiles/{z}/{x}/{y}.pbf`;

  return { tileUrl, valid: true };
}

/**
 * Builds the MapLibre style JSON object for an offline vector tile source.
 *
 * This produces a minimal style spec that:
 * - Uses a single "offline-tiles" source pointing to local .pbf files
 * - Contains no external URLs (no outbound requests)
 * - Does not reference Google Maps, Apple MapKit, or Mapbox (Req 4.4)
 *
 * The style can be extended with layers by the consuming component.
 *
 * @param tileUrl - The resolved file:// URL template from resolveOfflineTileSource.
 * @returns A MapLibre style JSON object ready for use with MapLibreGL.MapView.
 */
export function buildOfflineStyle(tileUrl: string): Record<string, unknown> {
  return {
    version: 8,
    name: 'tramio-offline',
    sources: {
      'offline-tiles': {
        type: 'vector',
        tiles: [tileUrl],
        // Typical OSM vector tile zoom range
        minzoom: 0,
        maxzoom: 14,
      },
    },
    layers: [
      // Minimal background layer so the map is not blank
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#f8f4f0',
        },
      },
      // Basic land/water layers from OpenMapTiles schema
      {
        id: 'water',
        type: 'fill',
        source: 'offline-tiles',
        'source-layer': 'water',
        paint: {
          'fill-color': '#a0cfdf',
        },
      },
      {
        id: 'landcover',
        type: 'fill',
        source: 'offline-tiles',
        'source-layer': 'landcover',
        paint: {
          'fill-color': '#d8e8c8',
          'fill-opacity': 0.5,
        },
      },
      {
        id: 'road',
        type: 'line',
        source: 'offline-tiles',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#ffffff',
          'line-width': 1.5,
        },
      },
      {
        id: 'building',
        type: 'fill',
        source: 'offline-tiles',
        'source-layer': 'building',
        paint: {
          'fill-color': '#d9d0c9',
          'fill-opacity': 0.7,
        },
      },
      {
        id: 'place-label',
        type: 'symbol',
        source: 'offline-tiles',
        'source-layer': 'place',
        layout: {
          'text-field': '{name}',
          'text-size': 12,
        },
        paint: {
          'text-color': '#333333',
        },
      },
    ],
  };
}
