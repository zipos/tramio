// Tests for the atomic GTFS feed replacement helper. The key invariant
// (Req 18.2) is: validation failure on the new feed leaves the prior
// feed intact on disk. Validation success replaces it atomically.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MeteredConnectionError,
  cityGtfsDir,
  feedDir,
  feedStagingDir,
  replaceGtfsFeed,
} from './replace';
import { GtfsParseError } from './types';

const STOPS = `stop_id,stop_name,stop_lat,stop_lon
A,Rynek,51.110,17.030
B,Plac Solny,51.111,17.032
C,Galeria,51.114,17.041
D,Dworzec,51.118,17.050
`;

const TRIPS = `trip_id,route_id,service_id,direction_id
T1,7,WK,0
T3,7,WK,1
`;

const CALENDAR = `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
WK,1,1,1,1,1,0,0,20240101,20241231
`;

const STOP_TIMES = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,A,1
T1,08:03:00,08:03:30,B,2
T1,08:08:00,08:08:30,C,3
T1,08:14:00,08:14:30,D,4
T3,08:30:00,08:30:30,D,1
T3,08:36:00,08:36:30,C,2
T3,08:41:00,08:41:30,B,3
T3,08:44:00,08:44:30,A,4
`;

function fixtureFetcher(overrides: Partial<Record<string, string>> = {}) {
  const base: Record<string, string> = {
    'stops.txt': STOPS,
    'stop_times.txt': STOP_TIMES,
    'trips.txt': TRIPS,
    'calendar.txt': CALENDAR,
  };
  return async (name: string): Promise<string> => {
    const merged = { ...base, ...overrides };
    if (!(name in merged)) {
      throw new Error(`unexpected fetch: ${name}`);
    }
    return merged[name] as string;
  };
}

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tramio-gtfs-replace-'));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('replaceGtfsFeed', () => {
  let support: string;

  beforeEach(async () => {
    support = await mkTmp();
  });

  afterEach(async () => {
    await rmTmp(support);
  });

  it('downloads, validates, and writes the four files into the final dir', async () => {
    const layout = { supportDir: support };
    const feed = await replaceGtfsFeed(layout, 'krk', {
      feedVersion: '2024-05-01',
      fetchFile: fixtureFetcher(),
    });

    expect(feed.feedVersion()).toBe('2024-05-01');
    const dir = feedDir(layout, 'krk', '2024-05-01');
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    for (const f of ['stops.txt', 'stop_times.txt', 'trips.txt', 'calendar.txt']) {
      expect((await fs.stat(path.join(dir, f))).isFile()).toBe(true);
    }
    // No staging leftovers.
    await expect(fs.access(feedStagingDir(layout, 'krk', '2024-05-01'))).rejects.toThrow();
  });

  it('replaces a prior feed atomically and leaves no staging dir behind', async () => {
    const layout = { supportDir: support };

    await replaceGtfsFeed(layout, 'krk', {
      feedVersion: 'v1',
      fetchFile: fixtureFetcher(),
    });
    await replaceGtfsFeed(layout, 'krk', {
      feedVersion: 'v2',
      fetchFile: fixtureFetcher(),
    });

    // v2 is on disk and v1 was overwritten only via the rename of a
    // separate version directory: the per-city dir contains exactly v2.
    const cityDir = cityGtfsDir(layout, 'krk');
    const entries = (await fs.readdir(cityDir)).sort();
    expect(entries).toEqual(['v2']);
  });

  it('leaves the prior feed in place when validation of the new feed fails', async () => {
    const layout = { supportDir: support };

    // Install a known-good prior feed at version v1.
    await replaceGtfsFeed(layout, 'krk', {
      feedVersion: 'v1',
      fetchFile: fixtureFetcher(),
    });

    const v1 = feedDir(layout, 'krk', 'v1');
    const stopsBefore = await fs.readFile(path.join(v1, 'stops.txt'), 'utf8');

    // Try to replace with a broken feed (stop_times references unknown stop "Z").
    const badStopTimes = `trip_id,arrival_time,departure_time,stop_id,stop_sequence
T1,08:00:00,08:00:30,Z,1
`;

    await expect(
      replaceGtfsFeed(layout, 'krk', {
        feedVersion: 'v2',
        fetchFile: fixtureFetcher({ 'stop_times.txt': badStopTimes }),
      }),
    ).rejects.toBeInstanceOf(GtfsParseError);

    // v1 still exists with the same bytes; v2 final dir does NOT exist;
    // staging dir was cleaned up.
    expect(await fs.readFile(path.join(v1, 'stops.txt'), 'utf8')).toBe(stopsBefore);
    await expect(fs.access(feedDir(layout, 'krk', 'v2'))).rejects.toThrow();
    await expect(fs.access(feedStagingDir(layout, 'krk', 'v2'))).rejects.toThrow();
  });

  it('refuses to download on a metered connection', async () => {
    const layout = { supportDir: support };
    let fetched = 0;
    await expect(
      replaceGtfsFeed(layout, 'krk', {
        feedVersion: 'v1',
        isUnmetered: () => false,
        fetchFile: async (name) => {
          fetched++;
          return await fixtureFetcher()(name);
        },
      }),
    ).rejects.toBeInstanceOf(MeteredConnectionError);
    expect(fetched).toBe(0);
    // No directory was created either.
    await expect(fs.access(cityGtfsDir(layout, 'krk'))).rejects.toThrow();
  });

  it('rejects path-traversal in cityId or feedVersion', async () => {
    const layout = { supportDir: support };
    await expect(
      replaceGtfsFeed(layout, '../escape', {
        feedVersion: 'v1',
        fetchFile: fixtureFetcher(),
      }),
    ).rejects.toThrow(/cityId/);
    await expect(
      replaceGtfsFeed(layout, 'krk', {
        feedVersion: 'a/b',
        fetchFile: fixtureFetcher(),
      }),
    ).rejects.toThrow(/feedVersion/);
  });

  it('cleans up staging from a previous failed attempt before retrying', async () => {
    const layout = { supportDir: support };
    // Pre-populate a staging dir with stale junk to simulate a crash on
    // the previous run.
    const staging = feedStagingDir(layout, 'krk', 'v1');
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, 'stale.txt'), 'leftover');

    await replaceGtfsFeed(layout, 'krk', {
      feedVersion: 'v1',
      fetchFile: fixtureFetcher(),
    });

    const final = feedDir(layout, 'krk', 'v1');
    const entries = (await fs.readdir(final)).sort();
    expect(entries).toEqual(['calendar.txt', 'stop_times.txt', 'stops.txt', 'trips.txt']);
  });

  it('attaches publishedAt so feedAgeDays works on the returned feed', async () => {
    const layout = { supportDir: support };
    const feed = await replaceGtfsFeed(layout, 'krk', {
      feedVersion: 'v1',
      publishedAt: new Date('2024-05-01T00:00:00Z'),
      fetchFile: fixtureFetcher(),
    });
    expect(feed.feedAgeDays({ now: new Date('2024-05-31T00:00:00Z') })).toBeCloseTo(30, 6);
  });
});
