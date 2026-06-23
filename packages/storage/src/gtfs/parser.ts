// GTFS feed parser for the four files Tramio's MVP consumes:
// `stops.txt`, `stop_times.txt`, `trips.txt`, `calendar.txt`.
//
// The parser is intentionally strict on required columns and lenient on
// surplus columns: a feed that publishes additional GTFS fields beyond the
// MVP's needs (e.g., `route_short_name` in `routes.txt`, `wheelchair_boarding`
// in `stops.txt`) is still consumed. Required columns missing from the
// header are surfaced as `GtfsParseError` with the offending file/column.
//
// @see Requirements 4.2, 4.3, 6.2, 18.1, 18.2

import { parseCsv } from './csv';
import {
  GtfsParseError,
  type GtfsCalendar,
  type GtfsDirection,
  type GtfsStop,
  type GtfsStopTime,
  type GtfsTrip,
  type ParsedGtfsFeed,
} from './types';

/** Source bytes for the four files we parse. Pass UTF-8 strings. */
export interface GtfsFeedSources {
  readonly stops: string;
  readonly stopTimes: string;
  readonly trips: string;
  readonly calendar: string;
}

export interface ParseGtfsFeedOptions {
  /** Feed version label (e.g., catalog `feedVersion` field). */
  readonly feedVersion: string;
}

/**
 * Parse the four GTFS files into typed row collections. Performs basic
 * cross-file validation: every `stop_times.stop_id` resolves to a known
 * stop, every `stop_times.trip_id` and `trips.service_id` resolves, and
 * `stop_times` rows are sorted within each trip by `stop_sequence`.
 *
 * Throws `GtfsParseError` on any structural problem so the catalog
 * operator (and the atomic-replacement helper below) can refuse a bad
 * feed before it overwrites the working copy on device.
 */
export function parseGtfsFeed(src: GtfsFeedSources, opts: ParseGtfsFeedOptions): ParsedGtfsFeed {
  if (typeof opts.feedVersion !== 'string' || opts.feedVersion.length === 0) {
    throw new GtfsParseError('feedVersion must be a non-empty string', { file: '<options>' });
  }

  const stops = parseStops(src.stops);
  const trips = parseTrips(src.trips);
  const calendar = parseCalendar(src.calendar);
  const stopTimes = parseStopTimes(src.stopTimes);

  // Cross-file validation.
  const stopIds = new Set(stops.map((s) => s.stopId));
  const tripIds = new Set(trips.map((t) => t.tripId));
  const serviceIds = new Set(calendar.map((c) => c.serviceId));

  for (const t of trips) {
    if (!serviceIds.has(t.serviceId)) {
      throw new GtfsParseError(
        `trips.txt: unknown service_id ${JSON.stringify(t.serviceId)} for trip ${JSON.stringify(t.tripId)}`,
        { file: 'trips.txt', column: 'service_id' },
      );
    }
  }

  for (const st of stopTimes) {
    if (!tripIds.has(st.tripId)) {
      throw new GtfsParseError(`stop_times.txt: unknown trip_id ${JSON.stringify(st.tripId)}`, {
        file: 'stop_times.txt',
        column: 'trip_id',
      });
    }
    if (!stopIds.has(st.stopId)) {
      throw new GtfsParseError(`stop_times.txt: unknown stop_id ${JSON.stringify(st.stopId)}`, {
        file: 'stop_times.txt',
        column: 'stop_id',
      });
    }
  }

  // Sort stop_times within each trip by stop_sequence so consumers can
  // assume traversal order. We sort a stable copy so the input order
  // among siblings of equal sequence is preserved (defensive; GTFS
  // forbids equal sequence numbers within a trip).
  const sortedStopTimes = [...stopTimes].sort((a, b) => {
    if (a.tripId === b.tripId) return a.stopSequence - b.stopSequence;
    return a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0;
  });

  // Detect duplicate (trip_id, stop_sequence) pairs.
  for (let i = 1; i < sortedStopTimes.length; i++) {
    const prev = sortedStopTimes[i - 1] as GtfsStopTime;
    const cur = sortedStopTimes[i] as GtfsStopTime;
    if (prev.tripId === cur.tripId && prev.stopSequence === cur.stopSequence) {
      throw new GtfsParseError(
        `stop_times.txt: duplicate stop_sequence ${cur.stopSequence} for trip ${JSON.stringify(cur.tripId)}`,
        { file: 'stop_times.txt', column: 'stop_sequence' },
      );
    }
  }

  return {
    feedVersion: opts.feedVersion,
    stops,
    stopTimes: sortedStopTimes,
    trips,
    calendar,
  };
}

// ----- Per-file parsers --------------------------------------------------

function parseStops(input: string): ReadonlyArray<GtfsStop> {
  const file = 'stops.txt';
  const { header, rows } = parseCsv(input);
  requireColumns(file, header, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon']);
  const out: GtfsStop[] = [];
  rows.forEach((row, idx) => {
    const line = idx + 2; // header is line 1
    const stopId = requireField(file, line, row, 'stop_id');
    const stopName = requireField(file, line, row, 'stop_name');
    const stopLat = parseFloatField(file, line, row, 'stop_lat');
    const stopLon = parseFloatField(file, line, row, 'stop_lon');
    if (stopLat < -90 || stopLat > 90) {
      throw new GtfsParseError(`stops.txt:${line}: stop_lat out of range (-90, 90): ${stopLat}`, {
        file,
        line,
        column: 'stop_lat',
      });
    }
    if (stopLon < -180 || stopLon > 180) {
      throw new GtfsParseError(`stops.txt:${line}: stop_lon out of range (-180, 180): ${stopLon}`, {
        file,
        line,
        column: 'stop_lon',
      });
    }
    out.push({ stopId, stopName, stopLat, stopLon });
  });
  return out;
}

function parseTrips(input: string): ReadonlyArray<GtfsTrip> {
  const file = 'trips.txt';
  const { header, rows } = parseCsv(input);
  requireColumns(file, header, ['trip_id', 'route_id', 'service_id', 'direction_id']);
  const out: GtfsTrip[] = [];
  rows.forEach((row, idx) => {
    const line = idx + 2;
    const tripId = requireField(file, line, row, 'trip_id');
    const routeId = requireField(file, line, row, 'route_id');
    const serviceId = requireField(file, line, row, 'service_id');
    const dirRaw = requireField(file, line, row, 'direction_id');
    if (dirRaw !== '0' && dirRaw !== '1') {
      throw new GtfsParseError(
        `trips.txt:${line}: direction_id must be 0 or 1, got ${JSON.stringify(dirRaw)}`,
        { file, line, column: 'direction_id' },
      );
    }
    const directionId: GtfsDirection = dirRaw === '0' ? 0 : 1;
    const headsignRaw = row.get('trip_headsign');
    const trip: GtfsTrip =
      headsignRaw !== undefined && headsignRaw.length > 0
        ? { tripId, routeId, serviceId, directionId, tripHeadsign: headsignRaw }
        : { tripId, routeId, serviceId, directionId };
    out.push(trip);
  });
  return out;
}

function parseCalendar(input: string): ReadonlyArray<GtfsCalendar> {
  const file = 'calendar.txt';
  const { header, rows } = parseCsv(input);
  requireColumns(file, header, [
    'service_id',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'start_date',
    'end_date',
  ]);
  const out: GtfsCalendar[] = [];
  rows.forEach((row, idx) => {
    const line = idx + 2;
    const serviceId = requireField(file, line, row, 'service_id');
    const monday = parseBoolField(file, line, row, 'monday');
    const tuesday = parseBoolField(file, line, row, 'tuesday');
    const wednesday = parseBoolField(file, line, row, 'wednesday');
    const thursday = parseBoolField(file, line, row, 'thursday');
    const friday = parseBoolField(file, line, row, 'friday');
    const saturday = parseBoolField(file, line, row, 'saturday');
    const sunday = parseBoolField(file, line, row, 'sunday');
    const startDate = parseGtfsDateField(file, line, row, 'start_date');
    const endDate = parseGtfsDateField(file, line, row, 'end_date');
    out.push({
      serviceId,
      monday,
      tuesday,
      wednesday,
      thursday,
      friday,
      saturday,
      sunday,
      startDate,
      endDate,
    });
  });
  return out;
}

function parseStopTimes(input: string): ReadonlyArray<GtfsStopTime> {
  const file = 'stop_times.txt';
  const { header, rows } = parseCsv(input);
  requireColumns(file, header, [
    'trip_id',
    'arrival_time',
    'departure_time',
    'stop_id',
    'stop_sequence',
  ]);
  const out: GtfsStopTime[] = [];
  rows.forEach((row, idx) => {
    const line = idx + 2;
    const tripId = requireField(file, line, row, 'trip_id');
    const stopId = requireField(file, line, row, 'stop_id');
    const stopSequence = parseIntField(file, line, row, 'stop_sequence');
    if (stopSequence < 0) {
      throw new GtfsParseError(
        `stop_times.txt:${line}: stop_sequence must be non-negative, got ${stopSequence}`,
        { file, line, column: 'stop_sequence' },
      );
    }
    const arrivalTimeSec = parseGtfsTimeField(file, line, row, 'arrival_time');
    const departureTimeSec = parseGtfsTimeField(file, line, row, 'departure_time');
    out.push({ tripId, stopId, stopSequence, arrivalTimeSec, departureTimeSec });
  });
  return out;
}

// ----- Field helpers ------------------------------------------------------

function requireColumns(
  file: string,
  header: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): void {
  for (const col of required) {
    if (!header.includes(col)) {
      throw new GtfsParseError(`${file}: missing required column ${JSON.stringify(col)}`, {
        file,
        column: col,
      });
    }
  }
}

function requireField(
  file: string,
  line: number,
  row: ReadonlyMap<string, string>,
  col: string,
): string {
  const v = row.get(col);
  if (v === undefined || v.length === 0) {
    throw new GtfsParseError(`${file}:${line}: missing value for column ${JSON.stringify(col)}`, {
      file,
      line,
      column: col,
    });
  }
  return v;
}

function parseFloatField(
  file: string,
  line: number,
  row: ReadonlyMap<string, string>,
  col: string,
): number {
  const raw = requireField(file, line, row, col);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new GtfsParseError(
      `${file}:${line}: column ${JSON.stringify(col)} is not a finite number: ${JSON.stringify(raw)}`,
      { file, line, column: col },
    );
  }
  return n;
}

function parseIntField(
  file: string,
  line: number,
  row: ReadonlyMap<string, string>,
  col: string,
): number {
  const raw = requireField(file, line, row, col);
  if (!/^-?\d+$/.test(raw)) {
    throw new GtfsParseError(
      `${file}:${line}: column ${JSON.stringify(col)} is not an integer: ${JSON.stringify(raw)}`,
      { file, line, column: col },
    );
  }
  return Number.parseInt(raw, 10);
}

function parseBoolField(
  file: string,
  line: number,
  row: ReadonlyMap<string, string>,
  col: string,
): boolean {
  const raw = requireField(file, line, row, col);
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new GtfsParseError(
    `${file}:${line}: column ${JSON.stringify(col)} must be 0 or 1, got ${JSON.stringify(raw)}`,
    { file, line, column: col },
  );
}

function parseGtfsDateField(
  file: string,
  line: number,
  row: ReadonlyMap<string, string>,
  col: string,
): number {
  const raw = requireField(file, line, row, col);
  if (!/^\d{8}$/.test(raw)) {
    throw new GtfsParseError(
      `${file}:${line}: column ${JSON.stringify(col)} must be YYYYMMDD, got ${JSON.stringify(raw)}`,
      { file, line, column: col },
    );
  }
  return Number.parseInt(raw, 10);
}

/**
 * Parse a GTFS time field into seconds since service-day start.
 *
 * Format is `HH:MM:SS` with `HH` allowed to exceed 23 (GTFS allows trips
 * that cross midnight: `25:30:00` is 1:30 AM the day after service start).
 * `H:MM:SS` is also accepted; some agencies omit the leading zero.
 */
function parseGtfsTimeField(
  file: string,
  line: number,
  row: ReadonlyMap<string, string>,
  col: string,
): number {
  const raw = requireField(file, line, row, col);
  const m = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(raw);
  if (!m) {
    throw new GtfsParseError(
      `${file}:${line}: column ${JSON.stringify(col)} must be HH:MM:SS, got ${JSON.stringify(raw)}`,
      { file, line, column: col },
    );
  }
  const hh = Number.parseInt(m[1] as string, 10);
  const mm = Number.parseInt(m[2] as string, 10);
  const ss = Number.parseInt(m[3] as string, 10);
  if (mm > 59 || ss > 59) {
    throw new GtfsParseError(
      `${file}:${line}: column ${JSON.stringify(col)} has invalid minute/second: ${JSON.stringify(raw)}`,
      { file, line, column: col },
    );
  }
  return hh * 3600 + mm * 60 + ss;
}
