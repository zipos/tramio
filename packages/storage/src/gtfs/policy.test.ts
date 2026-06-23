// Unit tests for the GTFS feed age policy enforcement.
//
// @see Requirements 18.3, 18.4

import { GtfsFeed } from './feed';
import { parseGtfsFeed } from './parser';
import {
  DR_DISABLED_DAYS,
  evaluateGtfsAgePolicy,
  gtfsAgeWarning,
  STALE_WARNING_DAYS,
} from './policy';

// Minimal valid GTFS data — the policy only cares about feed metadata,
// not the actual schedule content.
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

function buildFeedPublishedAt(publishedAt: Date): GtfsFeed {
  const parsed = parseGtfsFeed(
    { stops: STOPS, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
    { feedVersion: 'test-v1' },
  );
  return new GtfsFeed(parsed, { feedVersion: 'test-v1', publishedAt });
}

function buildFeedWithoutPublishedAt(): GtfsFeed {
  const parsed = parseGtfsFeed(
    { stops: STOPS, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
    { feedVersion: 'test-v1' },
  );
  return new GtfsFeed(parsed);
}

describe('evaluateGtfsAgePolicy', () => {
  it('returns no warnings for a fresh feed (< 30 days)', () => {
    const published = new Date('2024-05-01T00:00:00Z');
    const now = new Date('2024-05-20T00:00:00Z'); // 19 days old
    const feed = buildFeedPublishedAt(published);

    const policy = evaluateGtfsAgePolicy(feed, { now });

    expect(policy.staleWarning).toBe(false);
    expect(policy.drDisabled).toBe(false);
    expect(policy.feedAgeDays).toBeCloseTo(19, 5);
  });

  it('returns staleWarning=true when feed is exactly 30 days old', () => {
    // "older than 30 days" means > 30, so exactly 30 should NOT trigger
    const published = new Date('2024-05-01T00:00:00Z');
    const now = new Date('2024-05-31T00:00:00Z'); // exactly 30 days
    const feed = buildFeedPublishedAt(published);

    const policy = evaluateGtfsAgePolicy(feed, { now });

    expect(policy.staleWarning).toBe(false);
    expect(policy.drDisabled).toBe(false);
  });

  it('returns staleWarning=true when feed is > 30 days old', () => {
    const published = new Date('2024-05-01T00:00:00Z');
    const now = new Date('2024-06-01T00:00:00Z'); // 31 days
    const feed = buildFeedPublishedAt(published);

    const policy = evaluateGtfsAgePolicy(feed, { now });

    expect(policy.staleWarning).toBe(true);
    expect(policy.drDisabled).toBe(false);
    expect(policy.feedAgeDays).toBeCloseTo(31, 5);
  });

  it('returns drDisabled=true when feed is > 90 days old', () => {
    const published = new Date('2024-01-01T00:00:00Z');
    const now = new Date('2024-04-02T00:00:00Z'); // 92 days
    const feed = buildFeedPublishedAt(published);

    const policy = evaluateGtfsAgePolicy(feed, { now });

    expect(policy.staleWarning).toBe(true);
    expect(policy.drDisabled).toBe(true);
    expect(policy.feedAgeDays).toBeCloseTo(92, 0);
  });

  it('returns drDisabled=false when feed is exactly 90 days old', () => {
    const published = new Date('2024-01-01T00:00:00Z');
    const now = new Date('2024-03-31T00:00:00Z'); // exactly 90 days
    const feed = buildFeedPublishedAt(published);

    const policy = evaluateGtfsAgePolicy(feed, { now });

    expect(policy.staleWarning).toBe(true);
    expect(policy.drDisabled).toBe(false);
  });

  it('returns no warnings for a feed without publishedAt', () => {
    const feed = buildFeedWithoutPublishedAt();
    const now = new Date('2099-01-01T00:00:00Z');

    const policy = evaluateGtfsAgePolicy(feed, { now });

    expect(policy.staleWarning).toBe(false);
    expect(policy.drDisabled).toBe(false);
    expect(policy.feedAgeDays).toBe(0);
  });

  it('uses Date.now() when no now option is provided', () => {
    // Published far in the past so it's definitely stale
    const published = new Date('2020-01-01T00:00:00Z');
    const feed = buildFeedPublishedAt(published);

    const policy = evaluateGtfsAgePolicy(feed);

    expect(policy.staleWarning).toBe(true);
    expect(policy.drDisabled).toBe(true);
  });
});

describe('gtfsAgeWarning', () => {
  it('returns null for a fresh feed', () => {
    const warning = gtfsAgeWarning({
      staleWarning: false,
      drDisabled: false,
      feedAgeDays: 15,
    });
    expect(warning).toBeNull();
  });

  it('returns a stale warning when staleWarning is true', () => {
    const warning = gtfsAgeWarning({
      staleWarning: true,
      drDisabled: false,
      feedAgeDays: 45.7,
    });

    expect(warning).not.toBeNull();
    expect(warning!.severity).toBe('stale');
    expect(warning!.ageDays).toBe(45);
    expect(warning!.message).toContain('45 days old');
    expect(warning!.message).toContain('may be inaccurate');
  });

  it('returns a dr-disabled warning when drDisabled is true', () => {
    const warning = gtfsAgeWarning({
      staleWarning: true,
      drDisabled: true,
      feedAgeDays: 100.3,
    });

    expect(warning).not.toBeNull();
    expect(warning!.severity).toBe('dr-disabled');
    expect(warning!.ageDays).toBe(100);
    expect(warning!.message).toContain('100 days old');
    expect(warning!.message).toContain('Dead Reckoning');
    expect(warning!.message).toContain('disabled');
  });

  it('prefers dr-disabled severity over stale when both are true', () => {
    const warning = gtfsAgeWarning({
      staleWarning: true,
      drDisabled: true,
      feedAgeDays: 91,
    });

    expect(warning!.severity).toBe('dr-disabled');
  });
});

describe('threshold constants', () => {
  it('STALE_WARNING_DAYS is 30', () => {
    expect(STALE_WARNING_DAYS).toBe(30);
  });

  it('DR_DISABLED_DAYS is 90', () => {
    expect(DR_DISABLED_DAYS).toBe(90);
  });
});
