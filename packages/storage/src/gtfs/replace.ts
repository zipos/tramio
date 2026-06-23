// Atomic GTFS feed replacement.
//
// design.md "Storage_Manager" pins GTFS feeds under
// `${support}/gtfs/{cityId}/{feedVersion}/`. design.md "Catalog_Client"
// notes the unmetered/metered policy: probes are allowed on any
// connection, downloads only on unmetered. Req 18.2 explicitly states the
// app MUST replace the local copy *atomically* over an unmetered
// connection.
//
// The helper here separates the policy ("only download on unmetered")
// from the mechanism ("stage to a sibling directory, validate, rename
// into place"). The mechanism reuses `stageAndRename` from `../fs.ts` so
// the same atomic primitive that backs Offline_Pack downloads also backs
// GTFS feed replacement.
//
// On validation failure the staging directory is removed and the prior
// feed directory is left untouched. This is what gives us the "leaves the
// prior feed in place if validation fails" guarantee.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { stageAndRename } from '../fs';
import { parseGtfsFeed, type GtfsFeedSources } from './parser';
import { GtfsFeed, type GtfsFeedMetadata } from './feed';
import { GtfsParseError } from './types';

/** Read fn the helper uses to fetch each of the four GTFS files. */
export type GtfsFileFetcher = (file: GtfsFileName) => Promise<string>;

/** Network-policy probe: must return true before the helper will download. */
export type UnmeteredProbe = () => boolean | Promise<boolean>;

/** The four files Tramio's MVP consumes. */
export type GtfsFileName = 'stops.txt' | 'stop_times.txt' | 'trips.txt' | 'calendar.txt';

const REQUIRED_FILES: ReadonlyArray<GtfsFileName> = [
  'stops.txt',
  'stop_times.txt',
  'trips.txt',
  'calendar.txt',
];

export interface ReplaceGtfsFeedOptions {
  /** Catalog `feedVersion` label. Becomes the directory name on disk. */
  readonly feedVersion: string;
  /** Wall-clock instant the feed was published, surfaced in `GtfsFeed`. */
  readonly publishedAt?: Date;
  /** Resolves to the bytes of each of the four required files. */
  readonly fetchFile: GtfsFileFetcher;
  /**
   * Network-policy probe. Defaults to "true" (assume unmetered) so the
   * helper can be called from tests without wiring a probe; production
   * code MUST pass a real probe so Req 18.2 is respected.
   */
  readonly isUnmetered?: UnmeteredProbe;
}

export interface GtfsLayout {
  /** Absolute path to the platform support / app-support directory. */
  readonly supportDir: string;
}

/**
 * Thrown when `replaceGtfsFeed` refuses to download because the network
 * policy probe reported a metered connection. This is a normal control
 * flow signal, not a programmer error: the caller (a periodic task or a
 * settings screen) should retry on the next unmetered window.
 */
export class MeteredConnectionError extends Error {
  public override readonly name = 'MeteredConnectionError';
}

/** Root of the GTFS store: `${support}/gtfs/`. */
export function gtfsRoot(layout: GtfsLayout): string {
  return path.join(layout.supportDir, 'gtfs');
}

/** Per-city GTFS dir: `${support}/gtfs/{cityId}/`. */
export function cityGtfsDir(layout: GtfsLayout, cityId: string): string {
  assertSafeSegment('cityId', cityId);
  return path.join(gtfsRoot(layout), cityId);
}

/** Final feed dir: `${support}/gtfs/{cityId}/{feedVersion}/`. */
export function feedDir(layout: GtfsLayout, cityId: string, feedVersion: string): string {
  assertSafeSegment('cityId', cityId);
  assertSafeSegment('feedVersion', feedVersion);
  return path.join(gtfsRoot(layout), cityId, feedVersion);
}

/** Staging dir: `${support}/gtfs/{cityId}/{feedVersion}.staging/`. */
export function feedStagingDir(layout: GtfsLayout, cityId: string, feedVersion: string): string {
  assertSafeSegment('cityId', cityId);
  assertSafeSegment('feedVersion', feedVersion);
  return path.join(gtfsRoot(layout), cityId, `${feedVersion}.staging`);
}

/**
 * Download a GTFS feed and atomically replace any prior feed for the same
 * city. The new feed is fully parsed and cross-file-validated before any
 * filesystem rename happens; on any failure the staging directory is
 * removed and the prior feed (if any) is left in place.
 *
 * Returns a `GtfsFeed` ready for engine use.
 *
 * @throws MeteredConnectionError if the probe reports a metered connection.
 * @throws GtfsParseError if the feed fails to parse or cross-validate.
 *
 * @see Requirements 4.2, 4.3, 6.2, 18.1, 18.2
 */
export async function replaceGtfsFeed(
  layout: GtfsLayout,
  cityId: string,
  opts: ReplaceGtfsFeedOptions,
): Promise<GtfsFeed> {
  assertSafeSegment('cityId', cityId);
  if (typeof opts.feedVersion !== 'string' || opts.feedVersion.length === 0) {
    throw new GtfsParseError('feedVersion must be a non-empty string', { file: '<options>' });
  }
  assertSafeSegment('feedVersion', opts.feedVersion);

  const probe = opts.isUnmetered ?? (() => true);
  const unmetered = await probe();
  if (!unmetered) {
    throw new MeteredConnectionError(
      `replaceGtfsFeed(${cityId}): refusing to download on a metered connection (Req 18.2)`,
    );
  }

  const finalDir = feedDir(layout, cityId, opts.feedVersion);
  const staging = feedStagingDir(layout, cityId, opts.feedVersion);

  // Clean up any leftover staging from a previous failed attempt before we
  // start writing into it. We deliberately do NOT touch `finalDir` here —
  // that's the prior feed and it must stay readable until the very last
  // step succeeds.
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  let parsed;
  try {
    // Fetch into staging in parallel.
    const sources: GtfsFeedSources = {
      stops: '',
      stopTimes: '',
      trips: '',
      calendar: '',
    } as GtfsFeedSources;

    const fetched = await Promise.all(
      REQUIRED_FILES.map(async (file) => {
        const bytes = await opts.fetchFile(file);
        if (typeof bytes !== 'string') {
          throw new GtfsParseError(`fetchFile(${file}) did not return a string`, { file });
        }
        await fs.writeFile(path.join(staging, file), bytes, 'utf8');
        return [file, bytes] as const;
      }),
    );
    const map = new Map<GtfsFileName, string>(fetched);
    Object.assign(sources, {
      stops: map.get('stops.txt') ?? '',
      stopTimes: map.get('stop_times.txt') ?? '',
      trips: map.get('trips.txt') ?? '',
      calendar: map.get('calendar.txt') ?? '',
    });

    // Validate before any rename. This is the entire point of the helper:
    // a malformed feed must NOT replace the prior good feed on disk.
    parsed = parseGtfsFeed(sources, { feedVersion: opts.feedVersion });
  } catch (err) {
    // Best-effort cleanup; preserve the original error.
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // Validation succeeded. Promote staging -> finalDir atomically.
  // `stageAndRename` `rm`s any prior contents of `finalDir` first, so the
  // old feed is replaced in one atomic rename of the new directory into
  // place.
  await stageAndRename(staging, finalDir);

  // Req 18.2: "replace the local copy atomically." Each city carries at
  // most one feed at a time; once the new feed is safely in place, remove
  // any sibling feedVersion directories left over from prior generations.
  // This is best-effort: failure to clean up an old sibling is logged at
  // most by the host and never re-throws, since the new feed is already
  // committed.
  const cityRoot = cityGtfsDir(layout, cityId);
  try {
    const siblings = await fs.readdir(cityRoot, { withFileTypes: true });
    await Promise.all(
      siblings
        .filter(
          (e) => e.isDirectory() && e.name !== opts.feedVersion && !e.name.endsWith('.staging'),
        )
        .map((e) => fs.rm(path.join(cityRoot, e.name), { recursive: true, force: true })),
    );
  } catch {
    // Final dir promotion already succeeded; eviction is best-effort.
  }

  const metadata: GtfsFeedMetadata =
    opts.publishedAt !== undefined
      ? { feedVersion: opts.feedVersion, publishedAt: opts.publishedAt }
      : { feedVersion: opts.feedVersion };
  return new GtfsFeed(parsed, metadata);
}

const BAD_SEGMENT = /[/\\]/u;

function assertSafeSegment(label: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GtfsParseError(`${label} must be a non-empty string`, { file: '<options>' });
  }
  if (BAD_SEGMENT.test(value) || value === '.' || value === '..' || value.includes('\u0000')) {
    throw new GtfsParseError(`${label} contains a forbidden segment: ${value}`, {
      file: '<options>',
    });
  }
}
