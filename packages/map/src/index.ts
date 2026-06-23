// @tramio/map — public surface.
//
// MapLibre GL Native integration with offline vector tiles served from
// Storage_Manager. No outbound tile requests during an active tour
// (Req 3.2). No dependency on Google Maps Platform, Apple MapKit, or
// Mapbox commercial tiles (Req 4.4). Renders using MapLibre GL Native
// with OpenStreetMap-derived vector tiles (Req 4.1).
//
// @see design.md "### Storage_Manager"
// @see design.md "## Data Models > Authoring_Schema" (tiles/ directory)
// @see Requirements 3.2, 4.1, 4.4

export { OfflineMap } from './OfflineMap';
export { resolveOfflineTileSource, buildOfflineStyle } from './tileSource';
export type {
  OfflineMapProps,
  TilePackRef,
  ResolvedTileSource,
} from './types';
