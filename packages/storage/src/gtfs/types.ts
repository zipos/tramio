// Strongly-typed row models for the four GTFS files Tramio's MVP consumes.
//
// design.md "## Components and Interfaces > Storage_Manager" pins GTFS feeds
// to `${support}/gtfs/{cityId}/{feedVersion}/`. Tour_Engine Dead_Reckoning
// (Req 6.2) only needs stops, stop_times, trips, and calendar — agency.txt
// and routes.txt are out of scope for the MVP, since route metadata travels
// inside the authored Content_Bundle.
//
// All times are stored as integer seconds-since-service-start (NOT
// seconds-since-midnight), because GTFS allows arrival/departure times > 24h
// for trips that cross the day boundary. Dates are stored as the raw GTFS
// `YYYYMMDD` integer so we don't have to commit to a Date timezone here.
//
// @see Requirements 4.2, 4.3, 6.2

/**
 * One row of `stops.txt`. We keep only the fields the engine and the
 * authoring pipeline need; unknown columns are dropped at parse time.
 */
export interface GtfsStop {
  /** GTFS `stop_id`. Globally unique within a feed. */
  readonly stopId: string;
  /** Human-readable name; passed through to the authoring tooling. */
  readonly stopName: string;
  /** Latitude in degrees. */
  readonly stopLat: number;
  /** Longitude in degrees. */
  readonly stopLon: number;
}

/**
 * One row of `stop_times.txt`. The arrival/departure fields are normalized
 * to integer seconds (allowing >= 86400 for service that runs past midnight,
 * per the GTFS spec).
 */
export interface GtfsStopTime {
  readonly tripId: string;
  readonly stopId: string;
  /**
   * Position of this stop in the trip, 1-based per GTFS convention.
   * Must be strictly increasing within a trip.
   */
  readonly stopSequence: number;
  /** Seconds since service-day start. */
  readonly arrivalTimeSec: number;
  /** Seconds since service-day start. */
  readonly departureTimeSec: number;
}

/** Direction of travel along a route. GTFS encodes this as `0` or `1`. */
export type GtfsDirection = 0 | 1;

/**
 * One row of `trips.txt`. `directionId` is required by the engine to
 * disambiguate inbound/outbound; GTFS spec marks it optional, but a feed
 * that omits it is unusable for our DR lookups, so the parser surfaces a
 * clear error rather than silently coercing.
 */
export interface GtfsTrip {
  readonly tripId: string;
  readonly routeId: string;
  readonly serviceId: string;
  readonly directionId: GtfsDirection;
  readonly tripHeadsign?: string;
}

/**
 * One row of `calendar.txt`. `startDate`/`endDate` are stored as integer
 * `YYYYMMDD` so we can compare them without committing to a Date timezone
 * before the consumer (the engine, the GTFS-age policy in task 7.2)
 * decides which timezone matters.
 */
export interface GtfsCalendar {
  readonly serviceId: string;
  readonly monday: boolean;
  readonly tuesday: boolean;
  readonly wednesday: boolean;
  readonly thursday: boolean;
  readonly friday: boolean;
  readonly saturday: boolean;
  readonly sunday: boolean;
  /** GTFS `YYYYMMDD` integer; e.g. 20240501. */
  readonly startDate: number;
  /** GTFS `YYYYMMDD` integer; e.g. 20240731. */
  readonly endDate: number;
}

/**
 * Output of `parseGtfsFeed(...)`. Carries only the four files this MVP
 * consumes plus the feed version label that travels with the feed in the
 * catalog payload.
 */
export interface ParsedGtfsFeed {
  readonly feedVersion: string;
  readonly stops: ReadonlyArray<GtfsStop>;
  readonly stopTimes: ReadonlyArray<GtfsStopTime>;
  readonly trips: ReadonlyArray<GtfsTrip>;
  readonly calendar: ReadonlyArray<GtfsCalendar>;
}

/**
 * Thrown by the parser and the atomic-replacement helper when a feed is
 * structurally invalid (missing required column, malformed row, unknown
 * referenced id). Carries enough context for the catalog operator to
 * locate the offending row.
 */
export class GtfsParseError extends Error {
  public override readonly name = 'GtfsParseError';
  public readonly file: string;
  public readonly line?: number;
  public readonly column?: string;

  constructor(message: string, opts: { file: string; line?: number; column?: string }) {
    super(message);
    this.file = opts.file;
    if (opts.line !== undefined) this.line = opts.line;
    if (opts.column !== undefined) this.column = opts.column;
  }
}
