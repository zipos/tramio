// Unit test for the `bundle-validate` CLI (task 2.3).
//
// We drive the CLI through its `runCli` entry point against the
// in-memory `virtualFileSystem` rather than spawning a subprocess, so
// the test stays deterministic and fast. The smoke test for the
// underlying validator (validate.smoke.test.ts) already covers the
// classification of individual error kinds; this file's job is to
// verify the CLI shell:
//
//   1. exit code 0 + "Bundle is valid." line on a valid bundle (default mode)
//   2. exit code 0 + `[]` line on a valid bundle in `--json` mode
//   3. exit code 1 on a malformed bundle (default and `--json`)
//   4. human-readable mode emits the "filePath jsonPointer :: message"
//      line plus an indented "hint:" line per error
//   5. `parseArgs` rejects unknown flags / missing directory and the
//      argv-driven entry point returns exit code 2 in those cases

import { parseArgs, runCli, runCliFromArgv, type CliIo } from './bundle-validate';
import { virtualFileSystem } from '../validator';
import type { Manifest, Pois, Route } from '../types';

// ---------------------------------------------------------------------------
// Minimal valid in-memory bundle (mirrors the smoke fixture).
// ---------------------------------------------------------------------------

const validManifest: Manifest = {
  bundleId: 'wroclaw-tram-7-east',
  version: '1.0.0',
  city: { id: 'wroclaw', country: 'PL' },
  transitLine: { gtfsRouteId: '7', direction: 'east', agency: 'MPK' },
  languages: ['pl', 'en'],
  defaultLanguage: 'pl',
  minAppVersion: '1.0.0',
  deadReckoning: { permitted: true, maxLeadSeconds: 30 },
  standbyTracks: [],
  attribution: [{ kind: 'osm' }],
  checksumAlgorithm: 'sha256',
};

const validRoute: Route = {
  bundleId: 'wroclaw-tram-7-east',
  polyline: [
    [51.11, 17.03],
    [51.111, 17.032],
  ],
  stops: [
    { id: 'stop-001', gtfsStopId: '1234', coord: [51.11, 17.03], scheduledOffsetSec: 0 },
    {
      id: 'stop-002',
      gtfsStopId: '1235',
      coord: [51.114, 17.041],
      scheduledOffsetSec: 180,
    },
  ],
  deviationCorridorMeters: 150,
};

const validPois: Pois = {
  pois: [
    {
      id: 'poi-rynek',
      category: 'landmark',
      priority: 90,
      geometry: { kind: 'circle', center: [51.11, 17.031], radiusMeters: 60 },
      directionFilter: { kind: 'alongRoute', tolerance: 30 },
      dwellSec: 3,
      deferrable: true,
      drPermitted: true,
      tier: 'free',
      narratives: { pl: 'narratives/poi-rynek.pl.md' },
    },
  ],
};

const narrativePlMd = `---
poiId: poi-rynek
language: pl
durationHintSec: 45
---

# Rynek

Plac.
`;

function buildValidBundle(): Record<string, string | Buffer> {
  return {
    'manifest.json': JSON.stringify(validManifest),
    'route.json': JSON.stringify(validRoute),
    'pois.json': JSON.stringify(validPois),
    'narratives/poi-rynek.pl.md': narrativePlMd,
  };
}

// ---------------------------------------------------------------------------
// Test IO buffer
// ---------------------------------------------------------------------------

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

// `process.exitCode` is a global; we capture it before each test and
// restore it afterward so a test that sets it cannot bleed into the
// next.
let originalExitCode: number | undefined | string;
beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = originalExitCode as number | undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bundle-validate CLI (task 2.3)', () => {
  describe('parseArgs', () => {
    it('accepts a single positional directory argument', () => {
      const parsed = parseArgs(['/some/bundle']);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.directory).toBe('/some/bundle');
      expect(parsed.options.json).toBe(false);
      expect(parsed.options.strict).toBe(false);
    });

    it('parses --json and --strict flags in either order', () => {
      const a = parseArgs(['--json', '--strict', '/x']);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.options).toEqual({ json: true, strict: true });

      const b = parseArgs(['/x', '--strict', '--json']);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(b.options).toEqual({ json: true, strict: true });
    });

    it('rejects an unknown flag', () => {
      const r = parseArgs(['--nope', '/x']);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/unknown flag/);
    });

    it('rejects a missing positional directory', () => {
      const r = parseArgs(['--json']);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/missing required <bundle-dir>/);
    });

    it('rejects extra positional arguments', () => {
      const r = parseArgs(['/x', '/y']);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/unexpected positional/);
    });
  });

  describe('runCli on a valid bundle', () => {
    it('exits 0 with a friendly default-mode message', () => {
      const { io, out, err } = makeIo();
      const code = runCli(
        virtualFileSystem(buildValidBundle()),
        { json: false, strict: false },
        io,
      );
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out).toEqual(['Bundle is valid.']);
    });

    it('exits 0 with an empty JSON array in --json mode', () => {
      const { io, out, err } = makeIo();
      const code = runCli(virtualFileSystem(buildValidBundle()), { json: true, strict: false }, io);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out).toEqual(['[]']);
    });
  });

  describe('runCli on an invalid bundle', () => {
    it('exits 1 and groups errors by filePath in default mode', () => {
      const bundle = buildValidBundle();
      delete bundle['narratives/poi-rynek.pl.md'];
      const { io, out, err } = makeIo();
      const code = runCli(virtualFileSystem(bundle), { json: false, strict: false }, io);
      expect(code).toBe(1);
      // Default-mode errors go to stderr, not stdout.
      expect(out).toEqual([]);
      // Header line carries the error/file counts.
      expect(err[0]).toMatch(/^bundle-validate: \d+ error/);
      // At least one line follows the "<filePath> <jsonPointer> :: <message>"
      // shape, with a corresponding indented "hint:" line right after.
      const detailIdx = err.findIndex((line) => / :: /.test(line));
      expect(detailIdx).toBeGreaterThanOrEqual(0);
      const detailLine = err[detailIdx]!;
      expect(detailLine).toMatch(/pois\.json \/pois\/0\/narratives\/pl :: /);
      expect(err[detailIdx + 1]).toMatch(/^ {4}hint: /);
    });

    it('exits 1 and emits BundleValidationError[] verbatim in --json mode', () => {
      const bundle = buildValidBundle();
      delete bundle['narratives/poi-rynek.pl.md'];
      const { io, out, err } = makeIo();
      const code = runCli(virtualFileSystem(bundle), { json: true, strict: false }, io);
      expect(code).toBe(1);
      expect(err).toEqual([]);
      expect(out).toHaveLength(1);
      const parsed = JSON.parse(out[0]!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThan(0);
      const offender = parsed.find(
        (e: { jsonPointer: string }) => e.jsonPointer === '/pois/0/narratives/pl',
      );
      expect(offender).toBeDefined();
      expect(offender.filePath).toBe('pois.json');
      expect(offender.hint).toBeDefined();
      expect(typeof offender.hint.code).toBe('string');
    });
  });

  describe('runCliFromArgv argument-parsing failures', () => {
    it('returns exit code 2 on an unknown flag and prints to stderr', () => {
      const { io, out, err } = makeIo();
      const code = runCliFromArgv(['--bogus'], io);
      expect(code).toBe(2);
      expect(out).toEqual([]);
      expect(err.join('\n')).toMatch(/unknown flag/);
    });

    it('returns exit code 2 when the directory is missing', () => {
      const { io, out, err } = makeIo();
      const code = runCliFromArgv([], io);
      expect(code).toBe(2);
      expect(out).toEqual([]);
      expect(err.join('\n')).toMatch(/missing required <bundle-dir>/);
    });

    it('--help returns exit code 0 and prints usage to stdout', () => {
      const { io, out, err } = makeIo();
      const code = runCliFromArgv(['--help'], io);
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out.join('\n')).toMatch(/Usage: bundle-validate/);
    });
  });
});
