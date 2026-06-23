// `GtfsFeed`: lookup wrapper around a `ParsedGtfsFeed`.
//
// Tour_Engine Dead_Reckoning (Req 6.2) needs `scheduledOffsetSec(routeId,
// direction, stopId)` — the seconds elapsed from the route-start to the
// given stop along the active line direction. The class precomputes this
// once at construction time so the per-tick lookup the engine performs is
// O(1).
//
// Feed-age helpers feed the GTFS-age policy in task 7.2 (Req 18.3, 18.4).
//
// @see Requirements 4.2, 4.3, 6.2, 18.1, 18.2

import type {
  GtfsCalendar,
  GtfsDirection,
  GtfsStop,
  GtfsStopTime,
  GtfsTrip,
  ParsedGtfsFeed,
} from './types';

export interface FeedAgeOptions {
  /** Wall-clock instant to compute age against; defaults to `Date.now()`. */
  readonly now?: Date;
}

/**
 * The metadata `GtfsFeed` carries beyond the parsed rows. Both fields are
 * what the catalog payload (`GET /v1/gtfs/{cityId}/latest`) advertises:
 * `feedVersion` is opaque to us, `publishedAt` is the wall-clock instant
 * the catalog declared the feed published.
 */
export interface GtfsFeedMetadata {
  /** Feed version label from the catalog payload. */
  readonly feedVersion: string;
  /**
   * Wall-clock instant at which the catalog published this feed. Used by
   * `feedAgeDays(...)` and the GTFS-age policy enforcement (Req 18.3, 18.4).
   *
   * If the feed was constructed without a `publishedAt` (e.g. a local-only
   * test feed), `feedAgeDays` returns `0`.
   */
  readonly publishedAt?: Date;
}

export class GtfsFeed {
  /** All stops keyed by `stop_id`. */
  private readonly stopsById: ReadonlyMap<string, GtfsStop>;
  /** All trips keyed by `trip_id`. */
  private readonly tripsById: ReadonlyMap<string, GtfsTrip>;
  /** Trips grouped by `(routeId, directionId)`. */
  private readonly tripsByRouteDir: ReadonlyMap<string, ReadonlyArray<GtfsTrip>>;
  /** Stop_times grouped by `tripId`, sorted by `stop_sequence`. */
  private readonly stopTimesByTrip: ReadonlyMap<string, ReadonlyArray<GtfsStopTime>>;
  /**
   * Per-trip lookup: `tripId -> stopId -> arrivalTimeSec - firstStopArrivalSec`.
   * Computed once at construction so that `scheduledOffsetSec` is a single
   * map access at runtime.
   */
  private readonly tripStopOffsets: ReadonlyMap<string, ReadonlyMap<string, number>>;

  constructor(
    public readonly parsed: ParsedGtfsFeed,
    private readonly metadata: GtfsFeedMetadata = { feedVersion: parsed.feedVersion },
  ) {
    this.stopsById = indexBy(parsed.stops, (s) => s.stopId);
    this.tripsById = indexBy(parsed.trips, (t) => t.tripId);
    this.tripsByRouteDir = groupBy(parsed.trips, routeDirKey);
    this.stopTimesByTrip = groupBy(parsed.stopTimes, (st) => st.tripId);
    this.tripStopOffsets = computeTripOffsets(this.stopTimesByTrip);
  }

  /** Feed version label from the catalog payload. */
  feedVersion(): string {
    return this.metadata.feedVersion;
  }

  /** All stops in this feed. */
  stops(): ReadonlyArray<GtfsStop> {
    return this.parsed.stops;
  }

  /** All trips in this feed. */
  trips(): ReadonlyArray<GtfsTrip> {
    return this.parsed.trips;
  }

  /** All calendar entries in this feed. */
  calendar(): ReadonlyArray<GtfsCalendar> {
    return this.parsed.calendar;
  }

  /** Resolve a stop by id, or `undefined` if unknown. */
  stop(stopId: string): GtfsStop | undefined {
    return this.stopsById.get(stopId);
  }

  /** Trip metadata by id, or `undefined` if unknown. */
  trip(tripId: string): GtfsTrip | undefined {
    return this.tripsById.get(tripId);
  }

  /**
   * All trips that match `(routeId, directionId)`. Returns an empty list
   * when none match. Used by the engine to enumerate candidate trips
   * during DR estimation.
   */
  tripsForLine(routeId: string, direction: GtfsDirection): ReadonlyArray<GtfsTrip> {
    return this.tripsByRouteDir.get(routeDirKey({ routeId, directionId: direction })) ?? [];
  }

  /**
   * Stop_times for a trip, sorted by stop_sequence. Empty list when the
   * trip is unknown.
   */
  stopTimesForTrip(tripId: string): ReadonlyArray<GtfsStopTime> {
    return this.stopTimesByTrip.get(tripId) ?? [];
  }

  /**
   * Seconds elapsed from a trip's first scheduled stop to the arrival at
   * `stopId` on the same trip.
   *
   * Returns `null` when the trip or stop is unknown to the trip.
   */
  tripScheduledOffsetSec(tripId: string, stopId: string): number | null {
    const offsets = this.tripStopOffsets.get(tripId);
    if (!offsets) return null;
    const off = offsets.get(stopId);
    return off === undefined ? null : off;
  }

  /**
   * Seconds elapsed from route-start to the arrival at `stopId` on the
   * given line (route + direction). Tour_Engine DR consumes this to
   * estimate the vehicle's along-route position when GPS is lost.
   *
   * Resolution rule:
   *   - Find every trip with this `routeId` and `direction`.
   *   - For each such trip whose stop_times include `stopId`, compute the
   *     offset from the trip's first stop to `stopId`.
   *   - Return the offset that appears in at least one such trip; if the
   *     feed is consistent (every trip on the same line touches the same
   *     stops in the same order), all candidates yield the same offset.
   *   - Pick the modal value to absorb the rare GTFS feed where one
   *     express trip skips a stop. If no trip on the line touches `stopId`,
   *     return `null`.
   *
   * The choice to pick the modal offset (rather than averaging) keeps the
   * DR estimate aligned with the schedule a typical rider experiences,
   * even when a feed contains a handful of express variants.
   *
   * @see Requirement 6.2 ("estimate the vehicle's position along the
   *      Route using ... the GTFS_Feed schedule for the active transit
   *      line, and elapsed time").
   */
  scheduledOffsetSec(routeId: string, direction: GtfsDirection, stopId: string): number | null {
    const trips = this.tripsForLine(routeId, direction);
    if (trips.length === 0) return null;
    const counts = new Map<number, number>();
    for (const trip of trips) {
      const off = this.tripScheduledOffsetSec(trip.tripId, stopId);
      if (off === null) continue;
      counts.set(off, (counts.get(off) ?? 0) + 1);
    }
    if (counts.size === 0) return null;
    let bestOff = Number.NaN;
    let bestCount = -1;
    for (const [off, count] of counts) {
      if (count > bestCount || (count === bestCount && off < bestOff)) {
        bestOff = off;
        bestCount = count;
      }
    }
    return bestOff;
  }

  /**
   * Age of this feed in days, computed as `(now - publishedAt) / 86400000`.
   * Returns `0` when the feed has no `publishedAt` (e.g. a local fixture),
   * because "no published date" is treated as "unknown freshness, do not
   * trigger stale warnings". The GTFS-age policy task (7.2) is responsible
   * for surfacing the warning thresholds.
   *
   * Negative results are clamped to `0` to handle small clock skew
   * gracefully.
   */
  feedAgeDays(opts: FeedAgeOptions = {}): number {
    const published = this.metadata.publishedAt;
    if (!published) return 0;
    const now = (opts.now ?? new Date()).getTime();
    const delta = now - published.getTime();
    if (delta <= 0) return 0;
    return delta / 86_400_000;
  }
}

// ----- Internal helpers ---------------------------------------------------

function indexBy<T, K>(items: ReadonlyArray<T>, key: (t: T) => K): ReadonlyMap<K, T> {
  const m = new Map<K, T>();
  for (const item of items) m.set(key(item), item);
  return m;
}

function groupBy<T, K>(
  items: ReadonlyArray<T>,
  key: (t: T) => K,
): ReadonlyMap<K, ReadonlyArray<T>> {
  const m = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    let bucket = m.get(k);
    if (!bucket) {
      bucket = [];
      m.set(k, bucket);
    }
    bucket.push(item);
  }
  return m as ReadonlyMap<K, ReadonlyArray<T>>;
}

function routeDirKey(t: { routeId: string; directionId: GtfsDirection }): string {
  return `${t.routeId}\x00${t.directionId}`;
}

/**
 * For each trip, build `stopId -> offset_seconds_from_first_stop`. The
 * "first stop" is the entry with the smallest `stop_sequence`. Stops are
 * already sorted in `stopTimesByTrip` so the first entry is canonical.
 *
 * If a trip lists the same `stop_id` more than once (e.g., a loop that
 * revisits a stop), the FIRST occurrence wins for the offset map. The
 * parser sorts by stop_sequence ascending, so this is the earliest
 * scheduled visit, which is what an engine doing DR from route-start
 * cares about.
 */
function computeTripOffsets(
  stopTimesByTrip: ReadonlyMap<string, ReadonlyArray<GtfsStopTime>>,
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const out = new Map<string, ReadonlyMap<string, number>>();
  for (const [tripId, stopTimes] of stopTimesByTrip) {
    if (stopTimes.length === 0) continue;
    const first = stopTimes[0] as GtfsStopTime;
    const baseSec = first.arrivalTimeSec;
    const offsets = new Map<string, number>();
    for (const st of stopTimes) {
      if (offsets.has(st.stopId)) continue;
      offsets.set(st.stopId, st.arrivalTimeSec - baseSec);
    }
    out.set(tripId, offsets);
  }
  return out;
}
