// Unit tests for the Offline_Pack downloader.
//
// Validates: Requirements 3.1, 3.3, 3.4, 3.5
// - Streaming SHA-256 verification
// - Dependency-order download
// - Resume skips verified assets
// - Pack not startable until all assets complete
// - Atomic .part -> final rename only after SHA match

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { StorageManager } from './manager';
import { betterSqliteDriver } from './sqlite';
import {
  OfflinePackDownloader,
  sortByDependencyOrder,
  verifyManifestSignature,
  canonicalJsonStringify,
  type ManifestLockAsset,
  type ManifestLockPayload,
  type PackHttpClient,
  type SignedManifest,
} from './downloader';
import type { PackRef } from './paths';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function generateKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function base64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function signPayload(privateKey: crypto.KeyObject, payload: unknown): string {
  const msg = Buffer.from(canonicalJsonStringify(payload), 'utf8');
  const sig = crypto.sign(null, msg, privateKey);
  return base64urlEncode(sig);
}

/** Create a fake asset with known content and SHA-256. */
function makeAsset(
  assetPath: string,
  content: Buffer | string,
  opts?: { protected?: boolean },
): { asset: ManifestLockAsset; content: Buffer } {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    asset: {
      path: assetPath,
      sizeBytes: buf.length,
      sha256,
      protected: opts?.protected ?? false,
    },
    content: buf,
  };
}

/** Build a signed manifest from assets. */
function buildSignedManifest(
  privateKey: crypto.KeyObject,
  bundleId: string,
  version: string,
  assets: ManifestLockAsset[],
): SignedManifest {
  const payload: ManifestLockPayload = {
    bundleId,
    version,
    assets,
    createdAt: new Date().toISOString(),
  };
  const signature = signPayload(privateKey, payload);
  return { payload, signature, kid: 'cat-test-01' };
}

/**
 * In-memory HTTP client that serves assets from a Map.
 * Optionally simulates interruptions at a given byte offset.
 */
class FakeHttpClient implements PackHttpClient {
  private manifests = new Map<string, SignedManifest>();
  private assets = new Map<string, Buffer>();
  public fetchCount = new Map<string, number>();
  public interruptAt: { assetPath: string; afterBytes: number } | null = null;

  addManifest(ref: PackRef, signed: SignedManifest): void {
    this.manifests.set(`${ref.bundleId}@${ref.version}`, signed);
  }

  addAsset(ref: PackRef, assetPath: string, content: Buffer): void {
    this.assets.set(`${ref.bundleId}@${ref.version}/${assetPath}`, content);
  }

  async fetchManifest(ref: PackRef): Promise<SignedManifest> {
    const key = `${ref.bundleId}@${ref.version}`;
    const m = this.manifests.get(key);
    if (!m) throw new Error(`manifest not found: ${key}`);
    return m;
  }

  async fetchAsset(ref: PackRef, assetPath: string): Promise<AsyncIterable<Uint8Array>> {
    const key = `${ref.bundleId}@${ref.version}/${assetPath}`;
    const count = (this.fetchCount.get(key) ?? 0) + 1;
    this.fetchCount.set(key, count);

    const buf = this.assets.get(key);
    if (!buf) throw new Error(`asset not found: ${key}`);

    const interruptAt = this.interruptAt;
    const self = this;

    return {
      async *[Symbol.asyncIterator]() {
        const chunkSize = 1024;
        for (let offset = 0; offset < buf.length; offset += chunkSize) {
          if (
            interruptAt &&
            interruptAt.assetPath === assetPath &&
            offset >= interruptAt.afterBytes
          ) {
            // Clear the interrupt so the next attempt succeeds.
            self.interruptAt = null;
            throw new Error(`simulated network interruption at byte ${offset}`);
          }
          yield buf.subarray(offset, Math.min(offset + chunkSize, buf.length));
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

interface TestContext {
  manager: StorageManager;
  docs: string;
  http: FakeHttpClient;
  downloader: OfflinePackDownloader;
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

async function setup(): Promise<TestContext> {
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-dl-'));
  const raw = new Database(':memory:');
  const manager = await StorageManager.open({
    layout: { docsDir: docs },
    driver: betterSqliteDriver(raw),
  });
  const { publicKey, privateKey } = generateKeyPair();
  const http = new FakeHttpClient();
  const downloader = new OfflinePackDownloader({
    storage: manager,
    http,
    verificationKey: publicKey,
  });
  return { manager, docs, http, downloader, publicKey, privateKey };
}

async function teardown(ctx: TestContext): Promise<void> {
  await ctx.manager.close();
  await fs.rm(ctx.docs, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sortByDependencyOrder', () => {
  it('sorts assets in manifest → route → POIs → narratives → audio → tiles order', () => {
    const assets: ManifestLockAsset[] = [
      { path: 'tiles/12/1/2.pbf', sizeBytes: 100, sha256: 'a'.repeat(64) },
      { path: 'audio/poi-1.en.m4a.enc', sizeBytes: 200, sha256: 'b'.repeat(64) },
      { path: 'pois.json', sizeBytes: 50, sha256: 'c'.repeat(64) },
      { path: 'manifest.json', sizeBytes: 30, sha256: 'd'.repeat(64) },
      { path: 'narratives/poi-1.en.md.enc', sizeBytes: 80, sha256: 'e'.repeat(64) },
      { path: 'route.json', sizeBytes: 40, sha256: 'f'.repeat(64) },
    ];
    const sorted = sortByDependencyOrder(assets);
    expect(sorted.map((a) => a.path)).toEqual([
      'manifest.json',
      'route.json',
      'pois.json',
      'narratives/poi-1.en.md.enc',
      'audio/poi-1.en.m4a.enc',
      'tiles/12/1/2.pbf',
    ]);
  });

  it('preserves stable order within the same category', () => {
    const assets: ManifestLockAsset[] = [
      { path: 'narratives/z.md', sizeBytes: 10, sha256: 'a'.repeat(64) },
      { path: 'narratives/a.md', sizeBytes: 10, sha256: 'b'.repeat(64) },
      { path: 'narratives/m.md', sizeBytes: 10, sha256: 'c'.repeat(64) },
    ];
    const sorted = sortByDependencyOrder(assets);
    expect(sorted.map((a) => a.path)).toEqual([
      'narratives/a.md',
      'narratives/m.md',
      'narratives/z.md',
    ]);
  });
});

describe('verifyManifestSignature', () => {
  it('returns true for a valid signature', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const payload: ManifestLockPayload = {
      bundleId: 'test-bundle',
      version: '1.0.0',
      assets: [],
      createdAt: '2025-01-01T00:00:00Z',
    };
    const signature = signPayload(privateKey, payload);
    const signed: SignedManifest = { payload, signature, kid: 'cat-01' };
    expect(verifyManifestSignature(publicKey, signed)).toBe(true);
  });

  it('returns false for a tampered payload', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const payload: ManifestLockPayload = {
      bundleId: 'test-bundle',
      version: '1.0.0',
      assets: [],
      createdAt: '2025-01-01T00:00:00Z',
    };
    const signature = signPayload(privateKey, payload);
    const tampered = { ...payload, bundleId: 'evil-bundle' };
    const signed: SignedManifest = { payload: tampered, signature, kid: 'cat-01' };
    expect(verifyManifestSignature(publicKey, signed)).toBe(false);
  });

  it('returns false for a wrong key', () => {
    const { privateKey } = generateKeyPair();
    const { publicKey: wrongKey } = generateKeyPair();
    const payload: ManifestLockPayload = {
      bundleId: 'test-bundle',
      version: '1.0.0',
      assets: [],
      createdAt: '2025-01-01T00:00:00Z',
    };
    const signature = signPayload(privateKey, payload);
    const signed: SignedManifest = { payload, signature, kid: 'cat-01' };
    expect(verifyManifestSignature(wrongKey, signed)).toBe(false);
  });
});

describe('OfflinePackDownloader.download — happy path', () => {
  const BUNDLE_ID = 'wroclaw-tram-7-east';
  const VERSION = '1.4.2';

  it('downloads all assets, verifies SHA-256, and promotes staging to final', async () => {
    const ctx = await setup();
    try {
      const { asset: manifestAsset, content: manifestContent } = makeAsset(
        'manifest.json',
        JSON.stringify({ bundleId: BUNDLE_ID, version: VERSION }),
      );
      const { asset: routeAsset, content: routeContent } = makeAsset(
        'route.json',
        JSON.stringify({ polyline: [[51.11, 17.03]] }),
      );
      const { asset: poisAsset, content: poisContent } = makeAsset(
        'pois.json',
        JSON.stringify({ pois: [] }),
      );
      const { asset: narrativeAsset, content: narrativeContent } = makeAsset(
        'narratives/poi-rynek.en.md.enc',
        crypto.randomBytes(2048),
        { protected: true },
      );

      const assets = [manifestAsset, routeAsset, poisAsset, narrativeAsset];
      const ref: PackRef = { bundleId: BUNDLE_ID, version: VERSION };
      const signed = buildSignedManifest(ctx.privateKey, BUNDLE_ID, VERSION, assets);

      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', manifestContent);
      ctx.http.addAsset(ref, 'route.json', routeContent);
      ctx.http.addAsset(ref, 'pois.json', poisContent);
      ctx.http.addAsset(ref, 'narratives/poi-rynek.en.md.enc', narrativeContent);

      const result = await ctx.downloader.download(BUNDLE_ID, VERSION);
      expect(result.ok).toBe(true);

      // Final pack directory should exist.
      const finalDir = ctx.manager.packDir(ref);
      const stat = await fs.stat(finalDir);
      expect(stat.isDirectory()).toBe(true);

      // Staging directory should be gone.
      const stagingExists = await fs.stat(ctx.manager.stagingDir(ref)).catch(() => null);
      expect(stagingExists).toBeNull();

      // Verify on-disk content matches.
      const onDisk = await fs.readFile(path.join(finalDir, 'manifest.json'));
      expect(onDisk).toEqual(manifestContent);

      // Pack should be startable.
      expect(await ctx.downloader.isPackStartable(BUNDLE_ID, VERSION)).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });
});

describe('OfflinePackDownloader.download — signature verification', () => {
  it('rejects a manifest with an invalid signature', async () => {
    const ctx = await setup();
    try {
      const { asset: manifestAsset, content: manifestContent } = makeAsset(
        'manifest.json',
        '{}',
      );
      const ref: PackRef = { bundleId: 'b', version: '1.0.0' };

      // Sign with a different key than the verification key.
      const { privateKey: wrongKey } = generateKeyPair();
      const signed = buildSignedManifest(wrongKey, 'b', '1.0.0', [manifestAsset]);

      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', manifestContent);

      const result = await ctx.downloader.download('b', '1.0.0');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]!.kind).toBe('signature');
      }

      // Pack should NOT be startable.
      expect(await ctx.downloader.isPackStartable('b', '1.0.0')).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });

  it('rejects a manifest whose bundleId/version does not match the request', async () => {
    const ctx = await setup();
    try {
      const { asset: a } = makeAsset('manifest.json', '{}');
      const ref: PackRef = { bundleId: 'b', version: '1.0.0' };

      // Sign for a different bundle.
      const signed = buildSignedManifest(ctx.privateKey, 'other-bundle', '2.0.0', [a]);
      ctx.http.addManifest(ref, signed);

      const result = await ctx.downloader.download('b', '1.0.0');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]!.kind).toBe('manifest-fetch');
        expect(result.errors[0]!.message).toContain('mismatch');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('OfflinePackDownloader.download — SHA-256 mismatch', () => {
  it('fails when downloaded bytes do not match the lock file SHA', async () => {
    const ctx = await setup();
    try {
      const { asset: manifestAsset, content: manifestContent } = makeAsset(
        'manifest.json',
        '{"ok":true}',
      );
      const ref: PackRef = { bundleId: 'b', version: '1.0.0' };
      const signed = buildSignedManifest(ctx.privateKey, 'b', '1.0.0', [manifestAsset]);

      ctx.http.addManifest(ref, signed);
      // Serve corrupted content (different from what the SHA was computed over).
      ctx.http.addAsset(ref, 'manifest.json', Buffer.from('corrupted'));

      const result = await ctx.downloader.download('b', '1.0.0');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]!.kind).toBe('sha-mismatch');
        expect(result.errors[0]!.assetPath).toBe('manifest.json');
      }

      // Pack should NOT be startable.
      expect(await ctx.downloader.isPackStartable('b', '1.0.0')).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });
});

describe('OfflinePackDownloader.download — resume after interruption', () => {
  it('resumes from the last completed asset without re-fetching', async () => {
    const ctx = await setup();
    try {
      const { asset: manifestAsset, content: manifestContent } = makeAsset(
        'manifest.json',
        '{"id":"resume-test"}',
      );
      const { asset: routeAsset, content: routeContent } = makeAsset(
        'route.json',
        '{"polyline":[]}',
      );
      const { asset: poisAsset, content: poisContent } = makeAsset(
        'pois.json',
        '{"pois":[]}',
      );

      const ref: PackRef = { bundleId: 'resume', version: '1.0.0' };
      const assets = [manifestAsset, routeAsset, poisAsset];
      const signed = buildSignedManifest(ctx.privateKey, 'resume', '1.0.0', assets);

      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', manifestContent);
      ctx.http.addAsset(ref, 'route.json', routeContent);
      ctx.http.addAsset(ref, 'pois.json', poisContent);

      // Simulate interruption during the second asset (route.json).
      ctx.http.interruptAt = { assetPath: 'route.json', afterBytes: 0 };

      const result1 = await ctx.downloader.download('resume', '1.0.0');
      expect(result1.ok).toBe(false);
      if (!result1.ok) {
        expect(result1.errors.length).toBeGreaterThan(0);
        expect(result1.errors[0]!.assetPath).toBe('route.json');
      }

      // Pack should NOT be startable yet.
      expect(await ctx.downloader.isPackStartable('resume', '1.0.0')).toBe(false);

      // Clear the fetch count to track what gets re-fetched on resume.
      ctx.http.fetchCount.clear();

      // Resume: should skip manifest.json (already complete) and
      // re-download route.json. pois.json was already downloaded
      // successfully in the first attempt (the loop continues past errors).
      const result2 = await ctx.downloader.download('resume', '1.0.0');
      expect(result2.ok).toBe(true);

      // manifest.json should NOT have been re-fetched (completed in first attempt).
      const manifestFetches = ctx.http.fetchCount.get(
        `resume@1.0.0/manifest.json`,
      );
      expect(manifestFetches).toBeUndefined();

      // pois.json should NOT have been re-fetched (completed in first attempt).
      const poisFetches = ctx.http.fetchCount.get(`resume@1.0.0/pois.json`);
      expect(poisFetches).toBeUndefined();

      // route.json should have been fetched (it failed in the first attempt).
      expect(ctx.http.fetchCount.get(`resume@1.0.0/route.json`)).toBe(1);

      // Pack should now be startable.
      expect(await ctx.downloader.isPackStartable('resume', '1.0.0')).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });
});

describe('OfflinePackDownloader.isPackStartable', () => {
  it('returns false when the pack has never been downloaded', async () => {
    const ctx = await setup();
    try {
      expect(await ctx.downloader.isPackStartable('nonexistent', '1.0.0')).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });

  it('returns false when the staging directory exists but has not been promoted', async () => {
    const ctx = await setup();
    try {
      const ref: PackRef = { bundleId: 'partial', version: '1.0.0' };
      // Create staging dir manually (simulating an in-progress download).
      await fs.mkdir(ctx.manager.stagingDir(ref), { recursive: true });

      // Insert a partial row.
      await ctx.manager.driver.run(
        `INSERT INTO pack_progress
           (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
         VALUES (?, ?, ?, 'partial', 100, 50, NULL, ?)`,
        ['partial', '1.0.0', 'manifest.json', Date.now()],
      );

      expect(await ctx.downloader.isPackStartable('partial', '1.0.0')).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });

  it('returns false when the final dir exists but some assets are not complete', async () => {
    const ctx = await setup();
    try {
      const ref: PackRef = { bundleId: 'incomplete', version: '1.0.0' };
      // Create the final dir (simulating a promoted pack).
      await fs.mkdir(ctx.manager.packDir(ref), { recursive: true });

      // Insert one complete and one partial row.
      await ctx.manager.driver.run(
        `INSERT INTO pack_progress
           (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
         VALUES (?, ?, ?, 'complete', 100, 100, ?, ?)`,
        ['incomplete', '1.0.0', 'manifest.json', 'a'.repeat(64), Date.now()],
      );
      await ctx.manager.driver.run(
        `INSERT INTO pack_progress
           (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
         VALUES (?, ?, ?, 'partial', 200, 50, NULL, ?)`,
        ['incomplete', '1.0.0', 'route.json', Date.now()],
      );

      expect(await ctx.downloader.isPackStartable('incomplete', '1.0.0')).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });
});

describe('OfflinePackDownloader.download — pack_progress table state', () => {
  it('records all assets as complete after a successful download', async () => {
    const ctx = await setup();
    try {
      const { asset: a1, content: c1 } = makeAsset('manifest.json', '{"v":1}');
      const { asset: a2, content: c2 } = makeAsset('route.json', '{"r":1}');

      const ref: PackRef = { bundleId: 'progress', version: '1.0.0' };
      const signed = buildSignedManifest(ctx.privateKey, 'progress', '1.0.0', [a1, a2]);

      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', c1);
      ctx.http.addAsset(ref, 'route.json', c2);

      const result = await ctx.downloader.download('progress', '1.0.0');
      expect(result.ok).toBe(true);

      // All rows should be 'complete' with SHA-256 recorded.
      const rows = await ctx.manager.driver.all<{
        asset_path: string;
        status: string;
        sha256: string | null;
        bytes_done: number;
      }>(
        `SELECT asset_path, status, sha256, bytes_done FROM pack_progress
         WHERE bundle_id = ? AND version = ? ORDER BY asset_path`,
        ['progress', '1.0.0'],
      );

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe('complete');
        expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(row.bytes_done).toBeGreaterThan(0);
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('leaves failed assets as partial in pack_progress', async () => {
    const ctx = await setup();
    try {
      const { asset: a1, content: c1 } = makeAsset('manifest.json', '{"v":1}');
      const { asset: a2, content: c2 } = makeAsset('route.json', '{"r":1}');

      const ref: PackRef = { bundleId: 'fail', version: '1.0.0' };
      const signed = buildSignedManifest(ctx.privateKey, 'fail', '1.0.0', [a1, a2]);

      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', c1);
      // Serve corrupted content for route.json.
      ctx.http.addAsset(ref, 'route.json', Buffer.from('wrong'));

      const result = await ctx.downloader.download('fail', '1.0.0');
      expect(result.ok).toBe(false);

      // manifest.json should be complete, route.json should be partial.
      const rows = await ctx.manager.driver.all<{
        asset_path: string;
        status: string;
      }>(
        `SELECT asset_path, status FROM pack_progress
         WHERE bundle_id = ? AND version = ? ORDER BY asset_path`,
        ['fail', '1.0.0'],
      );

      const manifestRow = rows.find((r) => r.asset_path === 'manifest.json');
      const routeRow = rows.find((r) => r.asset_path === 'route.json');
      expect(manifestRow?.status).toBe('complete');
      expect(routeRow?.status).toBe('partial');
    } finally {
      await teardown(ctx);
    }
  });
});

describe('OfflinePackDownloader.download — no .part files in final directory', () => {
  it('final pack directory contains no .part files after successful download', async () => {
    const ctx = await setup();
    try {
      const { asset: a1, content: c1 } = makeAsset('manifest.json', '{"clean":true}');
      const { asset: a2, content: c2 } = makeAsset(
        'narratives/poi.en.md.enc',
        crypto.randomBytes(5000),
        { protected: true },
      );

      const ref: PackRef = { bundleId: 'clean', version: '1.0.0' };
      const signed = buildSignedManifest(ctx.privateKey, 'clean', '1.0.0', [a1, a2]);

      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', c1);
      ctx.http.addAsset(ref, 'narratives/poi.en.md.enc', c2);

      const result = await ctx.downloader.download('clean', '1.0.0');
      expect(result.ok).toBe(true);

      // Recursively list all files in the final directory.
      const finalDir = ctx.manager.packDir(ref);
      const allFiles = await listFilesRecursive(finalDir);
      for (const f of allFiles) {
        expect(f.endsWith('.part')).toBe(false);
      }
    } finally {
      await teardown(ctx);
    }
  });
});

/** Recursively list all file paths under `dir`. */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

describe('OfflinePackDownloader.download — manifest fetch failure', () => {
  it('returns an error when the manifest cannot be fetched', async () => {
    const ctx = await setup();
    try {
      // Don't add any manifest to the fake client.
      const result = await ctx.downloader.download('missing', '1.0.0');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]!.kind).toBe('manifest-fetch');
        expect(result.errors[0]!.assetPath).toBe('MANIFEST.lock.json');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('canonicalJsonStringify', () => {
  it('sorts object keys deterministically', () => {
    const obj = { z: 1, a: 2, m: 3 };
    expect(canonicalJsonStringify(obj)).toBe('{"a":2,"m":3,"z":1}');
  });

  it('handles nested objects and arrays', () => {
    const obj = { b: [3, 2, 1], a: { y: true, x: false } };
    expect(canonicalJsonStringify(obj)).toBe(
      '{"a":{"x":false,"y":true},"b":[3,2,1]}',
    );
  });

  it('handles null and primitives', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(42)).toBe('42');
    expect(canonicalJsonStringify('hello')).toBe('"hello"');
    expect(canonicalJsonStringify(true)).toBe('true');
  });
});
