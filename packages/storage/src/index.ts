// @tramio/storage — public surface.
//
// Storage_Manager: pack store, SQLite tables, atomic stage+rename writers,
// streaming SHA-256 verification, and the schema migrations. The
// Offline_Pack downloader, LRU evictor, and license-token refresh hooks
// land on top of this in tasks 5.2–5.5 and reuse the primitives below.
//
// @see design.md "### Storage_Manager"
// @see design.md "## Offline Pack Format and Download Strategy"
// @see design.md "License_Token format and lifecycle"

export { StorageManager, type StorageManagerOptions } from './manager';

export {
  packDir,
  packsRoot,
  stagingDir,
  InvalidPackRefError,
  type PackRef,
  type PathLayout,
} from './paths';

export { stageAndRename, verifySha256, sha256Hex, SHA256_CHUNK_BYTES } from './fs';

export {
  betterSqliteDriver,
  type SqliteDriver,
  type SqliteParams,
  type SqliteRow,
  type SqliteValue,
} from './sqlite';

export { migrate, readCurrentVersion, MIGRATIONS } from './migrations';

export {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  type DeviceIdRow,
  type EntitlementCacheRow,
  type LicenseTokenRow,
  type LruAccessRow,
  type ModerationSnapshotRow,
  type PackProgressRow,
  type PackProgressStatus,
} from './schema';

export {
  OfflinePackDownloader,
  sortByDependencyOrder,
  verifyManifestSignature,
  canonicalJsonStringify,
  type DownloadError,
  type DownloadErrorKind,
  type DownloadResult,
  type ManifestLockAsset,
  type ManifestLockAssetEncryption,
  type ManifestLockPayload,
  type OfflinePackDownloaderOptions,
  type PackHttpClient,
  type SignedManifest,
} from './downloader';

// Storage budget enforcement, LRU eviction, and storage UI data source.
// Validates: Requirements 19.1, 19.2, 19.3, 19.4, 19.5
export {
  StorageBudget,
  DEFAULT_BUDGET_BYTES,
  type ActiveTourProvider,
  type BudgetCheckResult,
  type EvictionMode,
  type PackUsageEntry,
  type StorageBudgetConfig,
  type StorageBudgetOptions,
  type StorageUsageSummary,
} from './budget';

// GTFS feed parser, lookup wrapper, and atomic replacement helper.
// Tour_Engine Dead_Reckoning consumes `GtfsFeed.scheduledOffsetSec` (Req
// 6.2); Catalog_Client uses `replaceGtfsFeed` for unmetered atomic feed
// replacement (Req 18.2).
export {
  GtfsFeed,
  GtfsParseError,
  MeteredConnectionError,
  cityGtfsDir,
  evaluateGtfsAgePolicy,
  feedDir,
  feedStagingDir,
  gtfsAgeWarning,
  gtfsRoot,
  parseGtfsFeed,
  replaceGtfsFeed,
  STALE_WARNING_DAYS,
  DR_DISABLED_DAYS,
  type FeedAgeOptions,
  type GtfsAgePolicy,
  type GtfsAgeWarning,
  type GtfsCalendar,
  type GtfsDirection,
  type GtfsFeedMetadata,
  type GtfsFeedSources,
  type GtfsFileFetcher,
  type GtfsFileName,
  type GtfsLayout,
  type GtfsStop,
  type GtfsStopTime,
  type GtfsTrip,
  type ParseGtfsFeedOptions,
  type ParsedGtfsFeed,
  type ReplaceGtfsFeedOptions,
  type UnmeteredProbe,
} from './gtfs';
