// @tramio/authoring
//
// Public surface of the Authoring_Schema package. Task 2.1 lands the
// TypeScript types and JSON Schema 2020-12 documents; task 2.2 will add the
// Content_Bundle validator on top of these schemas; task 2.3 wires the
// `bundle-validate` CLI.

export type {
  AttributionEntry,
  CcAttribution,
  CircleGeometry,
  DeeperLayer,
  DirectionFilter,
  EntitlementTier,
  Geometry,
  Iso31661Alpha2,
  Iso6391,
  LanguageMap,
  LatLng,
  Manifest,
  ManifestCity,
  ManifestDeadReckoning,
  ManifestTransitLine,
  NarrativeFrontmatter,
  NarrativeLicense,
  OsmAttribution,
  Poi,
  PoiCategory,
  Pois,
  PolygonGeometry,
  Route,
  StandbyCategory,
  StandbyTrack,
  Stop,
} from './types';

export type { JSONSchemaType } from './schemas/kind';
export type { AuthoringFileKind, AuthoringSchemaEntry } from './schemas/authoring';

export {
  AUTHORING_SCHEMA_BASE,
  AUTHORING_SCHEMA_VERSION,
  AUTHORING_SCHEMAS,
  findSchemaForPath,
} from './schemas/authoring';

export {
  ENTITLEMENT_TIERS,
  ISO_3166_1_ALPHA_2_PATTERN,
  ISO_639_1_PATTERN,
  POI_CATEGORIES,
  SCHEMA_BASE,
  SCHEMA_DRAFT,
  SCHEMA_VERSION,
  SEMVER_PATTERN,
  STANDBY_CATEGORIES,
} from './schemas/common';

export { manifestSchema, MANIFEST_SCHEMA_ID } from './schemas/manifest';
export { routeSchema, ROUTE_SCHEMA_ID } from './schemas/route';
export { poisSchema, POIS_SCHEMA_ID } from './schemas/pois';
export {
  narrativeFrontmatterSchema,
  NARRATIVE_FRONTMATTER_SCHEMA_ID,
} from './schemas/narrativeFrontmatter';
export { standbyTrackSchema, STANDBY_TRACK_SCHEMA_ID } from './schemas/standbyTrack';

// Content_Bundle validator (task 2.2)
export type {
  BundleFileSystem,
  BundleValidationError,
  Hint,
  HintCode,
  LoadedBundle,
  LoadedNarrative,
  ReadResult,
  ValidationResult,
  VirtualBundle,
} from './validator';
export { nodeFileSystem, validateBundle, virtualFileSystem } from './validator';
