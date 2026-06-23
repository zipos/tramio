// @tramio/authoring — Authoring_Schema TypeScript types.
//
// These mirror the canonical Content_Bundle shapes defined in
// `.kiro/specs/urban-narrative-mvp/design.md` under
// "Data Models > Authoring_Schema". They describe the *authoring* layout
// (plaintext JSON + Markdown) that content authors produce and the catalog
// ingests, before any encryption / pack-build step is applied.
//
// Engine-side runtime types (EngineEvent, EngineCommand, AcceptedUpdate,
// Geofence, Entitlement, …) live in `@tramio/engine` and are owned by task 3.1.

/** A `[latitude, longitude]` pair in WGS-84 decimal degrees. */
export type LatLng = readonly [number, number];

/**
 * ISO 639-1 two-letter language code (lowercase).
 *
 * Schema-level validation is enforced by a `^[a-z]{2}$` pattern. We do not
 * enumerate the full ISO 639-1 set at the type level on purpose: enumerating
 * would couple every TypeScript consumer to a specific dictionary version
 * while the schema's pattern stays ABI-compatible across registry updates.
 */
export type Iso6391 = string;

/** ISO 3166-1 alpha-2 country code (uppercase). */
export type Iso31661Alpha2 = string;

/**
 * Entitlement tier carried by a POI, deeper layer, narrative, or standby
 * track. Drives runtime gating in `@tramio/engine`.
 */
export type EntitlementTier = 'free' | 'time_pass' | 'token_unlock' | 'b2b';

/** Authored category for a POI. Drives priority comparators and styling. */
export type PoiCategory = 'landmark' | 'architectural-detail' | 'trivia';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface CircleGeometry {
  kind: 'circle';
  center: LatLng;
  radiusMeters: number;
}

export interface PolygonGeometry {
  kind: 'polygon';
  vertices: LatLng[];
}

export type Geometry = CircleGeometry | PolygonGeometry;

export interface DirectionFilter {
  kind: 'alongRoute';
  /**
   * Allowed angular deviation between the user's heading and the route
   * tangent, in degrees. Authored as `tolerance` per the design's
   * `pois.json` example.
   */
  tolerance: number;
}

// ---------------------------------------------------------------------------
// Language-keyed maps
// ---------------------------------------------------------------------------

/**
 * A map keyed on ISO 639-1 language codes. Path strings are relative to the
 * bundle root (e.g. `narratives/poi-rynek.pl.md`).
 */
export type LanguageMap<T> = Readonly<Record<string, T>>;

// ---------------------------------------------------------------------------
// Manifest (manifest.json)
// ---------------------------------------------------------------------------

export interface ManifestCity {
  id: string;
  country: Iso31661Alpha2;
}

export interface ManifestTransitLine {
  gtfsRouteId: string;
  direction: string;
  agency: string;
}

export interface ManifestDeadReckoning {
  permitted: boolean;
  maxLeadSeconds: number;
}

/** Plain OpenStreetMap attribution entry. */
export interface OsmAttribution {
  kind: 'osm';
}

/**
 * Creative Commons attribution entry. Carries the SPDX-style license
 * identifier and the human-readable attribution string required by
 * Requirement 17.2.
 */
export interface CcAttribution {
  kind: 'cc';
  license: string;
  attribution: string;
}

export type AttributionEntry = OsmAttribution | CcAttribution;

export interface Manifest {
  $schema?: string;
  bundleId: string;
  /** Semantic version of the bundle. */
  version: string;
  city: ManifestCity;
  transitLine: ManifestTransitLine;
  /** Supported ISO 639-1 codes. Must be non-empty and include `defaultLanguage`. */
  languages: Iso6391[];
  defaultLanguage: Iso6391;
  /** Minimum App version required to load the bundle (semver). */
  minAppVersion: string;
  deadReckoning: ManifestDeadReckoning;
  /** Authored standby-track ids referenced by `standby/{trackId}.json`. */
  standbyTracks: string[];
  attribution: AttributionEntry[];
  checksumAlgorithm: 'sha256';
}

// ---------------------------------------------------------------------------
// Route (route.json)
// ---------------------------------------------------------------------------

export interface Stop {
  id: string;
  gtfsStopId: string;
  coord: LatLng;
  /** Scheduled offset from route start, in seconds. Consumed by DR. */
  scheduledOffsetSec: number;
}

export interface Route {
  $schema?: string;
  bundleId: string;
  /** Ordered route polyline in WGS-84. */
  polyline: LatLng[];
  stops: Stop[];
  /** Distance (meters) defining the deviation corridor — Requirement 8.1. */
  deviationCorridorMeters: number;
}

// ---------------------------------------------------------------------------
// POIs (pois.json)
// ---------------------------------------------------------------------------

export interface DeeperLayer {
  id: string;
  tier: EntitlementTier;
  /** Path to the deeper-layer narrative Markdown file. */
  narrative: string;
}

export interface Poi {
  id: string;
  category: PoiCategory;
  /**
   * Priority used by the comparator when two geofences overlap.
   * Higher numbers win.
   */
  priority: number;
  geometry: Geometry;
  directionFilter?: DirectionFilter;
  /** Minimum dwell seconds before the trigger fires (>= 3, Req 5.3). */
  dwellSec: number;
  /** May the engine play this POI later, after a missed trigger? */
  deferrable: boolean;
  /** May the engine fire this POI from a Dead_Reckoning estimate? */
  drPermitted: boolean;
  tier: EntitlementTier;
  /**
   * Language-keyed paths to narrative Markdown files. Required: at minimum
   * the bundle's `defaultLanguage` must be present.
   */
  narratives: LanguageMap<string>;
  /**
   * Optional language-keyed paths to pre-rendered audio files. Each language
   * present here must also be present in `narratives` (transcript
   * requirement, Req 16.3); that cross-property invariant is enforced by
   * the validator (task 2.2) since pure JSON Schema cannot quantify it.
   */
  audio?: LanguageMap<string>;
  deeperLayers?: DeeperLayer[];
}

export interface Pois {
  $schema?: string;
  pois: Poi[];
}

// ---------------------------------------------------------------------------
// Narrative Markdown frontmatter
// ---------------------------------------------------------------------------

/** A single CC license citation inside a narrative's frontmatter. */
export interface NarrativeLicense {
  id: string;
  attribution: string;
}

export interface NarrativeFrontmatter {
  poiId: string;
  language: Iso6391;
  durationHintSec?: number;
  /**
   * Sponsor identifier. Required (and non-null, non-empty) when `tier` is
   * `b2b` (Req 14.5, 20.4). May be omitted or `null` for non-sponsored
   * content.
   */
  sponsor?: string | null;
  /**
   * Authored disclosure string spoken/displayed before sponsored content.
   * Required (non-null, non-empty) when `tier` is `b2b`.
   */
  disclosure?: string | null;
  /**
   * Per-narrative tier override. Defaults to the parent POI's tier when
   * omitted. The schema requires `b2b` narratives to carry sponsor +
   * disclosure.
   */
  tier?: EntitlementTier;
  licenses?: NarrativeLicense[];
}

// ---------------------------------------------------------------------------
// Standby track (standby/{trackId}.json)
// ---------------------------------------------------------------------------

export type StandbyCategory = 'trivia' | 'ambient';

export interface StandbyTrack {
  $schema?: string;
  id: string;
  category: StandbyCategory;
  /** ISO 639-1 codes for which a narrative is provided. */
  languages: Iso6391[];
  /**
   * Language-keyed paths to narrative Markdown for the track. Required
   * because every standby track must be displayable as a caption.
   */
  narratives: LanguageMap<string>;
  /**
   * Optional language-keyed paths to pre-rendered audio. Each language
   * present here must also be present in `narratives` (transcript
   * requirement, Req 16.3); enforced by the validator.
   */
  audio?: LanguageMap<string>;
  tier: EntitlementTier;
  /** When true, the engine may loop the track during long standby windows. */
  loop?: boolean;
  durationHintSec?: number;
}
