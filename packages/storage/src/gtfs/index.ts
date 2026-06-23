// @tramio/storage/gtfs — public surface for the GTFS feed support.
//
// The Tour_Engine consumes `GtfsFeed.scheduledOffsetSec(...)` during
// Dead_Reckoning (Req 6.2). The Catalog_Client downloads new feeds via
// `replaceGtfsFeed(...)` (Req 18.2) and gets back a fresh `GtfsFeed`
// ready for engine use.
//
// @see design.md "Storage_Manager"
// @see Requirements 4.2, 4.3, 6.2, 18.1, 18.2

export type {
  GtfsCalendar,
  GtfsDirection,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
  ParsedGtfsFeed,
} from './types';
export { GtfsParseError } from './types';

export { parseGtfsFeed, type GtfsFeedSources, type ParseGtfsFeedOptions } from './parser';

export { GtfsFeed, type FeedAgeOptions, type GtfsFeedMetadata } from './feed';

export {
  replaceGtfsFeed,
  cityGtfsDir,
  feedDir,
  feedStagingDir,
  gtfsRoot,
  MeteredConnectionError,
  type GtfsFileFetcher,
  type GtfsFileName,
  type GtfsLayout,
  type ReplaceGtfsFeedOptions,
  type UnmeteredProbe,
} from './replace';

export {
  evaluateGtfsAgePolicy,
  gtfsAgeWarning,
  STALE_WARNING_DAYS,
  DR_DISABLED_DAYS,
  type GtfsAgePolicy,
  type GtfsAgeWarning,
} from './policy';
