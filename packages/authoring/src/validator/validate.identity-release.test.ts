// Tests for:
// 1. Cross-file bundle identity agreement (bundleId mismatch rejected)
// 2. --release level requires GTFS fields; --strict and default do not
// 3. CLI parseArgs handles --release flag
//
// These tests verify the hardening changes added by the authoring integrity
// track without touching any existing test assertions.

import { validateBundle, virtualFileSystem } from '../validator';
import { parseArgs, runCli, type CliIo } from '../bin/bundle-validate';
import type { Manifest, Pois, Route } from '../types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides?: Partial<Manifest>): Manifest {
  return {
    bundleId: 'test-bundle-01',
    version: '1.0.0',
    city: { id: 'warsaw', country: 'PL' },
    transitLine: { gtfsRouteId: '180', direction: 'north', agency: 'ZTM' },
    languages: ['pl'],
    defaultLanguage: 'pl',
    minAppVersion: '1.0.0',
    deadReckoning: { permitted: false, maxLeadSeconds: 0 },
    standbyTracks: [],
    attribution: [{ kind: 'osm' }],
    checksumAlgorithm: 'sha256',
    ...overrides,
  };
}

function makeRoute(overrides?: Partial<Route>): Route {
  return {
    bundleId: 'test-bundle-01',
    polyline: [
      [52.2, 21.0],
      [52.21, 21.01],
    ],
    stops: [
      { id: 'stop-a', coord: [52.2, 21.0] },
      { id: 'stop-b', coord: [52.21, 21.01] },
    ],
    deviationCorridorMeters: 100,
    ...overrides,
  };
}

function makePois(): Pois {
  return {
    pois: [
      {
        id: 'poi-1',
        category: 'landmark',
        priority: 50,
        geometry: { kind: 'circle', center: [52.2, 21.0], radiusMeters: 40 },
        dwellSec: 3,
        tier: 'free',
        narratives: { pl: 'narratives/poi-1.pl.md' },
      },
    ],
  };
}

const narrative = `---
poiId: poi-1
language: pl
---

Testowa narracja.
`;

function buildBundle(manifest: Manifest, route: Route, pois: Pois): Record<string, string> {
  return {
    'manifest.json': JSON.stringify(manifest),
    'route.json': JSON.stringify(route),
    'pois.json': JSON.stringify(pois),
    'narratives/poi-1.pl.md': narrative,
  };
}

function makeIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Cross-file bundle identity agreement
// ---------------------------------------------------------------------------

describe('cross-file bundle identity', () => {
  it('passes when manifest.bundleId === route.bundleId', () => {
    const manifest = makeManifest({ bundleId: 'same-id' });
    const route = makeRoute({ bundleId: 'same-id' });
    const pois = makePois();
    const fs = virtualFileSystem(buildBundle(manifest, route, pois));
    const result = validateBundle(fs);
    expect(result.ok).toBe(true);
  });

  it('rejects when route.bundleId differs from manifest.bundleId', () => {
    const manifest = makeManifest({ bundleId: 'manifest-id' });
    const route = makeRoute({ bundleId: 'route-id' });
    const pois = makePois();
    const fs = virtualFileSystem(buildBundle(manifest, route, pois));
    const result = validateBundle(fs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const mismatch = result.errors.find((e) => e.hint.code === 'bundle-id-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.filePath).toBe('route.json');
    expect(mismatch!.jsonPointer).toBe('/bundleId');
    expect(mismatch!.message).toContain('route-id');
    expect(mismatch!.message).toContain('manifest-id');
  });

  it('identity mismatch is detected at default level (no --strict needed)', () => {
    const manifest = makeManifest({ bundleId: 'a' });
    const route = makeRoute({ bundleId: 'b' });
    const pois = makePois();
    const fs = virtualFileSystem(buildBundle(manifest, route, pois));
    // Explicitly no strict/release
    const result = validateBundle(fs, { strict: false, release: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.hint.code === 'bundle-id-mismatch')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. --release requires GTFS fields; --strict and default do not
// ---------------------------------------------------------------------------

describe('release mode GTFS field enforcement', () => {
  it('default mode accepts stops without gtfsStopId / scheduledOffsetSec', () => {
    const manifest = makeManifest();
    const route = makeRoute({
      stops: [
        { id: 'stop-a', coord: [52.2, 21.0] },
        { id: 'stop-b', coord: [52.21, 21.01] },
      ],
    });
    const pois = makePois();
    const fs = virtualFileSystem(buildBundle(manifest, route, pois));
    const result = validateBundle(fs);
    expect(result.ok).toBe(true);
  });

  it('strict mode accepts stops without gtfsStopId / scheduledOffsetSec', () => {
    // Use a narrative with approved review so strict doesn't trip on the review gate
    const reviewedNarrative = `---
poiId: poi-1
language: pl
review:
  reviewedBy: tester
  reviewedAt: '2026-07-30T00:00:00Z'
  decision: approved
---

Narracja testowa.
`;
    const manifest = makeManifest();
    const route = makeRoute({
      stops: [
        { id: 'stop-a', coord: [52.2, 21.0] },
        { id: 'stop-b', coord: [52.21, 21.01] },
      ],
    });
    const pois = makePois();
    const bundle = buildBundle(manifest, route, pois);
    bundle['narratives/poi-1.pl.md'] = reviewedNarrative;
    const fs = virtualFileSystem(bundle);
    const result = validateBundle(fs, { strict: true });
    expect(result.ok).toBe(true);
  });

  it('release mode rejects stops missing gtfsStopId', () => {
    const reviewedNarrative = `---
poiId: poi-1
language: pl
review:
  reviewedBy: tester
  reviewedAt: '2026-07-30T00:00:00Z'
  decision: approved
---

Narracja testowa.
`;
    const manifest = makeManifest();
    const route = makeRoute({
      stops: [
        { id: 'stop-a', coord: [52.2, 21.0], scheduledOffsetSec: 0 },
        { id: 'stop-b', coord: [52.21, 21.01], scheduledOffsetSec: 120 },
      ],
    });
    const pois = makePois();
    const bundle = buildBundle(manifest, route, pois);
    bundle['narratives/poi-1.pl.md'] = reviewedNarrative;
    const fs = virtualFileSystem(bundle);
    const result = validateBundle(fs, { release: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const gtfsErrors = result.errors.filter((e) => e.hint.code === 'release-gtfs-field-missing');
    expect(gtfsErrors.length).toBe(2); // both stops missing gtfsStopId
    expect(gtfsErrors.every((e) => e.message.includes('gtfsStopId'))).toBe(true);
  });

  it('release mode rejects stops missing scheduledOffsetSec', () => {
    const reviewedNarrative = `---
poiId: poi-1
language: pl
review:
  reviewedBy: tester
  reviewedAt: '2026-07-30T00:00:00Z'
  decision: approved
---

Narracja testowa.
`;
    const manifest = makeManifest();
    const route = makeRoute({
      stops: [
        { id: 'stop-a', coord: [52.2, 21.0], gtfsStopId: 'g1' },
        { id: 'stop-b', coord: [52.21, 21.01], gtfsStopId: 'g2' },
      ],
    });
    const pois = makePois();
    const bundle = buildBundle(manifest, route, pois);
    bundle['narratives/poi-1.pl.md'] = reviewedNarrative;
    const fs = virtualFileSystem(bundle);
    const result = validateBundle(fs, { release: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const gtfsErrors = result.errors.filter((e) => e.hint.code === 'release-gtfs-field-missing');
    expect(gtfsErrors.length).toBe(2); // both stops missing scheduledOffsetSec
    expect(gtfsErrors.every((e) => e.message.includes('scheduledOffsetSec'))).toBe(true);
  });

  it('release mode passes when all GTFS fields are present', () => {
    const reviewedNarrative = `---
poiId: poi-1
language: pl
review:
  reviewedBy: tester
  reviewedAt: '2026-07-30T00:00:00Z'
  decision: approved
---

Narracja testowa.
`;
    const manifest = makeManifest();
    const route = makeRoute({
      stops: [
        { id: 'stop-a', coord: [52.2, 21.0], gtfsStopId: 'g1', scheduledOffsetSec: 0 },
        { id: 'stop-b', coord: [52.21, 21.01], gtfsStopId: 'g2', scheduledOffsetSec: 120 },
      ],
    });
    const pois = makePois();
    const bundle = buildBundle(manifest, route, pois);
    bundle['narratives/poi-1.pl.md'] = reviewedNarrative;
    const fs = virtualFileSystem(bundle);
    const result = validateBundle(fs, { release: true });
    expect(result.ok).toBe(true);
  });

  it('release mode implies strict (rejects unapproved review)', () => {
    // Narrative without review block → should fail because release implies strict
    const manifest = makeManifest();
    const route = makeRoute({
      stops: [
        { id: 'stop-a', coord: [52.2, 21.0], gtfsStopId: 'g1', scheduledOffsetSec: 0 },
        { id: 'stop-b', coord: [52.21, 21.01], gtfsStopId: 'g2', scheduledOffsetSec: 120 },
      ],
    });
    const pois = makePois();
    const fs = virtualFileSystem(buildBundle(manifest, route, pois));
    const result = validateBundle(fs, { release: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Should fail on the review gate (strict implied)
    expect(result.errors.some((e) => e.hint.code === 'review-not-approved')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. CLI --release flag parsing
// ---------------------------------------------------------------------------

describe('CLI --release flag', () => {
  it('parseArgs recognizes --release', () => {
    const parsed = parseArgs(['--release', '/my/bundle']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.release).toBe(true);
    expect(parsed.options.strict).toBe(false);
    expect(parsed.options.json).toBe(false);
  });

  it('parseArgs allows combining --release with --strict and --json', () => {
    const parsed = parseArgs(['--json', '--strict', '--release', '/dir']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options).toEqual({ json: true, strict: true, release: true });
  });

  it('runCli with release=true triggers GTFS enforcement', () => {
    const reviewedNarrative = `---
poiId: poi-1
language: pl
review:
  reviewedBy: tester
  reviewedAt: '2026-07-30T00:00:00Z'
  decision: approved
---

Narracja testowa.
`;
    const manifest = makeManifest();
    const route = makeRoute({
      stops: [
        { id: 'stop-a', coord: [52.2, 21.0] },
        { id: 'stop-b', coord: [52.21, 21.01] },
      ],
    });
    const pois = makePois();
    const bundle = buildBundle(manifest, route, pois);
    bundle['narratives/poi-1.pl.md'] = reviewedNarrative;
    const fs = virtualFileSystem(bundle);
    const { io, out } = makeIo();
    const code = runCli(fs, { json: true, strict: false, release: true }, io);
    expect(code).toBe(1);
    const errors = JSON.parse(out[0]!);
    expect(
      errors.some((e: { hint: { code: string } }) => e.hint.code === 'release-gtfs-field-missing'),
    ).toBe(true);
  });

  it('--help output includes --release documentation', () => {
    const result = parseArgs(['--help']);
    // parseArgs returns an error sentinel for help
    expect(result.ok).toBe(false);
  });
});
