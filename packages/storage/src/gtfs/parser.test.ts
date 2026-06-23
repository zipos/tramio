// Unit tests for the GTFS feed parser. Feeds are inlined as strings.

import { parseGtfsFeed } from './parser';
import { GtfsParseError } from './types';

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

// Two east-bound trips and one west-bound trip.
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

describe('parseGtfsFeed', () => {
  it('parses a well-formed feed and reports the version', () => {
    const feed = parseGtfsFeed(
      { stops: STOPS, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
      { feedVersion: '2024-05-01' },
    );
    expect(feed.feedVersion).toBe('2024-05-01');
    expect(feed.stops).toHaveLength(4);
    expect(feed.trips).toHaveLength(3);
    expect(feed.calendar).toHaveLength(1);
    expect(feed.stopTimes).toHaveLength(12);
    // Stop_times must be sorted by (trip_id, stop_sequence).
    const t1 = feed.stopTimes.filter((st) => st.tripId === 'T1');
    expect(t1.map((st) => st.stopSequence)).toEqual([1, 2, 3, 4]);
  });

  it('parses HH:MM:SS times allowing past-midnight values', () => {
    const stopTimes = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,25:30:00,25:30:30,A,1
T1,26:00:00,26:00:30,B,2
`;
    const trips = `trip_id,route_id,service_id,direction_id
T1,9,WK,0
`;
    const stops = `stop_id,stop_name,stop_lat,stop_lon
A,A,51.0,17.0
B,B,51.1,17.1
`;
    const cal = CALENDAR;
    const feed = parseGtfsFeed(
      { stops, stopTimes, trips, calendar: cal },
      { feedVersion: 'past-mid' },
    );
    expect(feed.stopTimes[0]?.arrivalTimeSec).toBe(25 * 3600 + 30 * 60);
    expect(feed.stopTimes[1]?.arrivalTimeSec).toBe(26 * 3600);
  });

  it('rejects a missing required column', () => {
    const stopsBad = 'stop_id,stop_name,stop_lat\nA,Rynek,51.0\n';
    expect(() =>
      parseGtfsFeed(
        { stops: stopsBad, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(GtfsParseError);
  });

  it('rejects a malformed lat/lon', () => {
    const stopsBad = 'stop_id,stop_name,stop_lat,stop_lon\nA,Rynek,not-a-number,17.0\n';
    expect(() =>
      parseGtfsFeed(
        { stops: stopsBad, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(/finite number/);
  });

  it('rejects an out-of-range latitude', () => {
    const stopsBad = 'stop_id,stop_name,stop_lat,stop_lon\nA,A,91,17\n';
    expect(() =>
      parseGtfsFeed(
        { stops: stopsBad, stopTimes: STOP_TIMES, trips: TRIPS, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(/stop_lat/);
  });

  it('rejects a stop_times row with an unknown trip_id', () => {
    const stopTimesBad = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
TX,08:00:00,08:00:30,A,1
`;
    expect(() =>
      parseGtfsFeed(
        { stops: STOPS, stopTimes: stopTimesBad, trips: TRIPS, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(/unknown trip_id/);
  });

  it('rejects a stop_times row with an unknown stop_id', () => {
    const stopTimesBad = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,Z,1
`;
    expect(() =>
      parseGtfsFeed(
        { stops: STOPS, stopTimes: stopTimesBad, trips: TRIPS, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(/unknown stop_id/);
  });

  it('rejects a trip with an unknown service_id', () => {
    const tripsBad = `trip_id,route_id,service_id,direction_id
T1,7,WHO,0
`;
    const stopTimesOnlyT1 = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,A,1
T1,08:03:00,08:03:30,B,2
`;
    expect(() =>
      parseGtfsFeed(
        { stops: STOPS, stopTimes: stopTimesOnlyT1, trips: tripsBad, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(/unknown service_id/);
  });

  it('rejects an invalid direction_id', () => {
    const tripsBad = `trip_id,route_id,service_id,direction_id
T1,7,WK,2
`;
    const stopTimesOnlyT1 = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,A,1
`;
    expect(() =>
      parseGtfsFeed(
        { stops: STOPS, stopTimes: stopTimesOnlyT1, trips: tripsBad, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(/direction_id/);
  });

  it('rejects duplicate stop_sequence within a trip', () => {
    const stopTimesBad = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,A,1
T1,08:03:00,08:03:30,B,1
`;
    expect(() =>
      parseGtfsFeed(
        { stops: STOPS, stopTimes: stopTimesBad, trips: TRIPS, calendar: CALENDAR },
        { feedVersion: 'v' },
      ),
    ).toThrow(/duplicate stop_sequence/);
  });
});
