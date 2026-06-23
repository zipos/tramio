// Unit tests for the `GtfsFeed` lookup wrapper. The fixture below mirrors
// the design.md DR scenario: route 7, two east-bound trips and one
// west-bound trip, four stops along the line.

import { GtfsFeed } from './feed';
import { parseGtfsFeed } from './parser';

const STOPS = `stop_id,stop_name,stop_lat,stop_lon
A,Rynek,51.110,17.030
B,Plac Solny,51.111,17.032
C,Galeria,51.114,17.041
D,Dworzec,51.118,17.050
`;

const TRIPS = `trip_id,route_id,service_id,direction_id,trip_headsign
T1,7,WK,0,East Bound
T2,7,WK,0,East Bound
T3,7,WK,1,West Bound
`;

const CALENDAR = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WK,1,1,1,1,1,0,0,20240101,20241231
`;

// Two east-bound trips with identical stop spacing; one west-bound trip
// with different absolute clock times but symmetric stop spacing.
const STOP_TIMES = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,A,1
T1,08:03:00,08:03:30,B,2
T1,08:08:00,08:08:30,C,3
T1,08:14:00,08:14:30,D,4
T2,09:00:00,09:00:30,A,1
T2,09:03:00,09:03:30,B,2
T2,09:08:00,09:08:30,C,3
T2,09:14:00,09:14:30,D,4
T3,08:30:00,08:30:30,D,1
T3,08:36:00,08:36:30,C,2
T3,08:41:00,08:41:30,B,3
T3,08:44:00,08:44:30,A,4
`;

function buildFeed() {
  const parsed = parseGtfsFeed(
    { stops: STOPS, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
    { feedVersion: '2024-05-01' },
  );
  return new GtfsFeed(parsed, {
    feedVersion: '2024-05-01',
    publishedAt: new Date('2024-05-01T00:00:00Z'),
  });
}

describe('GtfsFeed.scheduledOffsetSec', () => {
  it('returns 0 for the first stop of every trip on the line', () => {
    const feed = buildFeed();
    expect(feed.scheduledOffsetSec('7', 0, 'A')).toBe(0);
    expect(feed.scheduledOffsetSec('7', 1, 'D')).toBe(0);
  });

  it('returns the shared offset for an east-bound stop served by two trips', () => {
    const feed = buildFeed();
    // T1: A 08:00 -> B 08:03 = 180s
    // T2: A 09:00 -> B 09:03 = 180s
    expect(feed.scheduledOffsetSec('7', 0, 'B')).toBe(180);
    // A -> C: 8 min
    expect(feed.scheduledOffsetSec('7', 0, 'C')).toBe(8 * 60);
    // A -> D: 14 min
    expect(feed.scheduledOffsetSec('7', 0, 'D')).toBe(14 * 60);
  });

  it('returns the west-bound offsets independently of east-bound', () => {
    const feed = buildFeed();
    // T3: D 08:30 -> A 08:44 = 14 min, with C at +6, B at +11
    expect(feed.scheduledOffsetSec('7', 1, 'C')).toBe(6 * 60);
    expect(feed.scheduledOffsetSec('7', 1, 'B')).toBe(11 * 60);
    expect(feed.scheduledOffsetSec('7', 1, 'A')).toBe(14 * 60);
  });

  it('returns null for an unknown route, direction, or stop', () => {
    const feed = buildFeed();
    expect(feed.scheduledOffsetSec('99', 0, 'A')).toBeNull();
    // Direction 1 still has trips on route 7, but stop "Z" is not in the feed.
    expect(feed.scheduledOffsetSec('7', 1, 'Z')).toBeNull();
  });

  it('picks the modal offset when one trip skips a stop', () => {
    // Add an express variant that skips C; the canonical offset for C
    // should still be the modal value the local trips agree on.
    const stopTimesWithExpress =
      STOP_TIMES +
      `T4,10:00:00,10:00:30,A,1
T4,10:02:00,10:02:30,B,2
T4,10:10:00,10:10:30,D,3
`;
    const trips =
      TRIPS +
      `T4,7,WK,0,East Bound Express
`;
    const parsed = parseGtfsFeed(
      { stops: STOPS, stopTimes: stopTimesWithExpress, trips, calendar: CALENDAR },
      { feedVersion: 'with-express' },
    );
    const feed = new GtfsFeed(parsed);
    // Two trips (T1, T2) say A->B = 180s; one (T4) says 120s. Modal -> 180.
    expect(feed.scheduledOffsetSec('7', 0, 'B')).toBe(180);
    // C is served by two trips at the same offset; T4 doesn't reach C.
    expect(feed.scheduledOffsetSec('7', 0, 'C')).toBe(8 * 60);
  });
});

describe('GtfsFeed lookup helpers', () => {
  it('resolves stops, trips, and trips-by-line', () => {
    const feed = buildFeed();
    expect(feed.stop('A')?.stopName).toBe('Rynek');
    expect(feed.trip('T2')?.routeId).toBe('7');
    expect(
      feed
        .tripsForLine('7', 0)
        .map((t) => t.tripId)
        .sort(),
    ).toEqual(['T1', 'T2']);
    expect(feed.tripsForLine('7', 1).map((t) => t.tripId)).toEqual(['T3']);
  });

  it('returns trip-specific offsets', () => {
    const feed = buildFeed();
    expect(feed.tripScheduledOffsetSec('T1', 'C')).toBe(8 * 60);
    expect(feed.tripScheduledOffsetSec('T1', 'Z')).toBeNull();
    expect(feed.tripScheduledOffsetSec('Tnope', 'A')).toBeNull();
  });
});

describe('GtfsFeed.feedAgeDays', () => {
  it('reports days elapsed since publishedAt', () => {
    const feed = buildFeed();
    const now = new Date('2024-06-01T00:00:00Z'); // 31 days after May 1.
    expect(feed.feedAgeDays({ now })).toBeCloseTo(31, 6);
  });

  it('clamps a small clock skew to 0', () => {
    const feed = buildFeed();
    const earlier = new Date('2024-04-01T00:00:00Z');
    expect(feed.feedAgeDays({ now: earlier })).toBe(0);
  });

  it('returns 0 when the feed has no publishedAt', () => {
    const parsed = parseGtfsFeed(
      { stops: STOPS, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
      { feedVersion: 'no-date' },
    );
    const feed = new GtfsFeed(parsed);
    expect(feed.feedAgeDays({ now: new Date('2099-01-01T00:00:00Z') })).toBe(0);
  });

  it('exposes feedVersion()', () => {
    expect(buildFeed().feedVersion()).toBe('2024-05-01');
  });
});
