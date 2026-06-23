// Property-based test for the GTFS feed age policy (task 7.3).
//
// Feature: urban-narrative-mvp, Property 16: GTFS-age policy controls
// warnings and dead-reckoning availability
//
// **Validates: Requirements 18.3, 18.4**
//
// Strategy:
//   Generate arbitrary feed ages (non-negative days) and verify:
//   1. For any feed age <= 30 days: staleWarning=false, drDisabled=false
//   2. For any feed age > 30 and <= 90 days: staleWarning=true, drDisabled=false
//   3. For any feed age > 90 days: staleWarning=true, drDisabled=true
//   4. drDisabled implies staleWarning (monotonicity)
//   5. feedAgeDays is always >= 0

import * as fc from 'fast-check';

import { GtfsFeed } from './feed';
import { parseGtfsFeed } from './parser';
import {
  DR_DISABLED_DAYS,
  evaluateGtfsAgePolicy,
  STALE_WARNING_DAYS,
  type GtfsAgePolicy,
} from './policy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal valid GTFS data — the policy only cares about feed metadata.
const STOPS = `stop_id,stop_name,stop_lat,stop_lon
A,Stop A,51.110,17.030
`;
const TRIPS = `trip_id,route_id,service_id,direction_id
T1,7,WK,0
`;
const CALENDAR = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WK,1,1,1,1,1,0,0,20240101,20241231
`;
const STOP_TIMES = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,A,1
`;

const PARSED = parseGtfsFeed(
  { stops: STOPS, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
  { feedVersion: 'prop16-v1' },
);

/**
 * Build a GtfsFeed whose `feedAgeDays(opts)` returns exactly `ageDays`.
 * We achieve this by setting `publishedAt` to `now - ageDays * 86400000`.
 */
function buildFeedWithAge(ageDays: number, now: Date): GtfsFeed {
  const publishedAt = new Date(now.getTime() - ageDays * 86_400_000);
  return new GtfsFeed(PARSED, { feedVersion: 'prop16-v1', publishedAt });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Arbitrary non-negative feed age in days. We use a double to cover
 * fractional days (e.g. 30.5 days) and ensure boundary behavior is
 * correct. Range [0, 365] covers all interesting thresholds.
 */
const arbFeedAgeDays = fc.double({ min: 0, max: 365, noNaN: true });

/** A fixed reference "now" for deterministic tests. */
const REFERENCE_NOW = new Date('2024-06-15T12:00:00Z');

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 16: GTFS-age policy controls warnings and dead-reckoning availability', () => {
  it('fresh feeds (age <= 30 days) have no warnings and DR enabled', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: STALE_WARNING_DAYS, noNaN: true }),
        (ageDays) => {
          const feed = buildFeedWithAge(ageDays, REFERENCE_NOW);
          const policy = evaluateGtfsAgePolicy(feed, { now: REFERENCE_NOW });

          expect(policy.staleWarning).toBe(false);
          expect(policy.drDisabled).toBe(false);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('stale feeds (30 < age <= 90 days) show stale warning but DR remains enabled', () => {
    fc.assert(
      fc.property(
        fc.double({
          min: STALE_WARNING_DAYS + 0.001,
          max: DR_DISABLED_DAYS,
          noNaN: true,
        }),
        (ageDays) => {
          const feed = buildFeedWithAge(ageDays, REFERENCE_NOW);
          const policy = evaluateGtfsAgePolicy(feed, { now: REFERENCE_NOW });

          expect(policy.staleWarning).toBe(true);
          expect(policy.drDisabled).toBe(false);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('very stale feeds (age > 90 days) show stale warning and DR is disabled', () => {
    fc.assert(
      fc.property(
        fc.double({ min: DR_DISABLED_DAYS + 0.001, max: 365, noNaN: true }),
        (ageDays) => {
          const feed = buildFeedWithAge(ageDays, REFERENCE_NOW);
          const policy = evaluateGtfsAgePolicy(feed, { now: REFERENCE_NOW });

          expect(policy.staleWarning).toBe(true);
          expect(policy.drDisabled).toBe(true);
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('drDisabled implies staleWarning (monotonicity)', () => {
    fc.assert(
      fc.property(arbFeedAgeDays, (ageDays) => {
        const feed = buildFeedWithAge(ageDays, REFERENCE_NOW);
        const policy = evaluateGtfsAgePolicy(feed, { now: REFERENCE_NOW });

        // If DR is disabled, the feed must also be flagged as stale.
        if (policy.drDisabled) {
          expect(policy.staleWarning).toBe(true);
        }
      }),
      { numRuns: 100, seed: 42 },
    );
  });

  it('feedAgeDays is always >= 0', () => {
    fc.assert(
      fc.property(arbFeedAgeDays, (ageDays) => {
        const feed = buildFeedWithAge(ageDays, REFERENCE_NOW);
        const policy = evaluateGtfsAgePolicy(feed, { now: REFERENCE_NOW });

        expect(policy.feedAgeDays).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 100, seed: 42 },
    );
  });
});
