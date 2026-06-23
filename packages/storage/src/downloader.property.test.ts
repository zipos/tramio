// Property-based test for the Offline_Pack download/resume round trip (task 5.3).
//
// Feature: urban-narrative-mvp, Property 14: Offline_Pack download/resume
// round trip preserves content and avoids re-fetching
//
// **Validates: Requirements 3.1, 3.3, 3.4, 3.5**
//
// Strategy:
//   1. Generate arbitrary pack manifests (1–8 assets with random content).
//   2. After a successful download, verify all on-disk content matches the
//      original assets byte-for-byte (SHA-256).
//   3. Simulate an interruption at a random asset index, then resume.
//      Assert the final content is identical to a clean download.
//   4. On resume, verify that assets already completed are NOT re-fetched
//      (fetch count = 0 for those assets).
//   5. Assert a pack is NOT startable until all assets are complete.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as fc from 'fast-check';
import Database from 'better-sqlite3';

import { StorageManager } from './manager';
import { betterSqliteDriver } from './sqlite';
import {
  OfflinePackDownloader,
  canonicalJsonStringify,
  type ManifestLockAsset,
  type ManifestLockPayload,
  type PackHttpClient,
  type SignedManifest,
} from './downloader';
import type { PackRef } from './paths';

// ---------------------------------------------------------------------------
// Test helpers (mirrors downloader.test.ts patterns)
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

function makeAsset(
  assetPath: string,
  content: Buffer,
  opts?: { protected?: boolean },
): { asset: ManifestLockAsset; content: Buffer } {
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  return {
    asset: {
      path: assetPath,
      sizeBytes: content.length,
      sha256,
      protected: opts?.protected ?? false,
    },
    content,
  };
}

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
 * Tracks fetch counts per asset and supports interruption at a specific
 * asset index during download.
 */
class FakeHttpClient implements PackHttpClient {
  private manifests = new Map<string, SignedManifest>();
  private assets = new Map<string, Buffer>();
  public fetchCount = new Map<string, number>();
  /** If set, the Nth asset fetch (0-indexed) will throw mid-stream. */
  public interruptAtAssetIndex: number | null = null;
  private fetchSequence = 0;

  addManifest(ref: PackRef, signed: SignedManifest): void {
    this.manifests.set(`${ref.bundleId}@${ref.version}`, signed);
  }

  addAsset(ref: PackRef, assetPath: string, content: Buffer): void {
    this.assets.set(`${ref.bundleId}@${ref.version}/${assetPath}`, content);
  }

  resetCounters(): void {
    this.fetchCount.clear();
    this.fetchSequence = 0;
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

    const currentIndex = this.fetchSequence++;
    const shouldInterrupt = this.interruptAtAssetIndex === currentIndex;

    return {
      async *[Symbol.asyncIterator]() {
        if (shouldInterrupt) {
          // Yield nothing and throw immediately to simulate a network failure
          // before any bytes are written.
          throw new Error(`simulated network interruption for asset at index ${currentIndex}`);
        }
        const chunkSize = 512;
        for (let offset = 0; offset < buf.length; offset += chunkSize) {
          yield buf.subarray(offset, Math.min(offset + chunkSize, buf.length));
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Test context setup/teardown
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
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-prop14-'));
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
// Generators
// ---------------------------------------------------------------------------

/** Asset category names used to build realistic pack-relative paths. */
const ASSET_CATEGORIES = [
  { prefix: 'manifest.json', singleton: true },
  { prefix: 'route.json', singleton: true },
  { prefix: 'pois.json', singleton: true },
  { prefix: 'narratives/', singleton: false },
  { prefix: 'audio/', singleton: false },
  { prefix: 'tiles/', singleton: false },
] as const;

/**
 * Generate a realistic pack asset path. The downloader sorts by dependency
 * order, so we want paths that span the categories.
 */
function arbAssetPath(index: number): string {
  // First three are always the singletons (manifest, route, pois).
  if (index === 0) return 'manifest.json';
  if (index === 1) return 'route.json';
  if (index === 2) return 'pois.json';
  // Remaining assets alternate between narratives, audio, and tiles.
  const categories = ['narratives', 'audio', 'tiles'];
  const cat = categories[(index - 3) % categories.length]!;
  const fileIndex = Math.floor((index - 3) / categories.length);
  if (cat === 'tiles') return `tiles/12/${fileIndex}/0.pbf`;
  const ext = cat === 'narratives' ? '.en.md.enc' : '.en.m4a.enc';
  return `${cat}/poi-${fileIndex}${ext}`;
}

/**
 * Arbitrary for a generated pack: produces an array of (assetPath, content)
 * pairs with 3–8 assets (always includes the 3 singletons).
 */
const arbPack = fc
  .integer({ min: 3, max: 8 })
  .chain((numAssets) =>
    fc.tuple(
      ...Array.from({ length: numAssets }, (_, i) =>
        fc
          .uint8Array({ minLength: 16, maxLength: 2048 })
          .map((bytes) => ({
            path: arbAssetPath(i),
            content: Buffer.from(bytes),
            protected: i >= 3 && arbAssetPath(i).endsWith('.enc'),
          })),
      ),
    ),
  );

/**
 * Arbitrary for the interruption point: an index into the asset array
 * (0-based) indicating which asset fetch should fail.
 */
function arbInterruptIndex(numAssets: number): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: numAssets - 1 });
}

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 14: Offline_Pack download/resume round trip preserves content and avoids re-fetching', () => {
  it('after a successful download, all on-disk content matches the original assets byte-for-byte', async () => {
    await fc.assert(
      fc.asyncProperty(arbPack, async (packAssets) => {
        const ctx = await setup();
        try {
          const bundleId = 'prop14-clean';
          const version = '1.0.0';
          const ref: PackRef = { bundleId, version };

          // Build assets and manifest.
          const assets: ManifestLockAsset[] = [];
          for (const a of packAssets) {
            const { asset, content } = makeAsset(a.path, a.content, {
              protected: a.protected,
            });
            assets.push(asset);
            ctx.http.addAsset(ref, a.path, content);
          }

          const signed = buildSignedManifest(ctx.privateKey, bundleId, version, assets);
          ctx.http.addManifest(ref, signed);

          // Download.
          const result = await ctx.downloader.download(bundleId, version);
          if (!result.ok) {
            throw new Error(
              `Download failed unexpectedly: ${result.errors.map((e) => e.message).join(', ')}`,
            );
          }

          // Verify all on-disk content matches byte-for-byte.
          const finalDir = ctx.manager.packDir(ref);
          for (const a of packAssets) {
            const onDisk = await fs.readFile(path.join(finalDir, a.path));
            const expectedSha = crypto.createHash('sha256').update(a.content).digest('hex');
            const actualSha = crypto.createHash('sha256').update(onDisk).digest('hex');
            if (actualSha !== expectedSha) {
              throw new Error(
                `SHA mismatch for ${a.path}: expected ${expectedSha}, got ${actualSha}`,
              );
            }
          }

          // Pack should be startable.
          const startable = await ctx.downloader.isPackStartable(bundleId, version);
          if (!startable) {
            throw new Error('Pack should be startable after successful download');
          }
        } finally {
          await teardown(ctx);
        }
      }),
      { numRuns: 100, seed: 42 },
    );
  });

  it('after an interrupted download and resume, the final content is identical to a clean download', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPack.chain((packAssets) =>
          fc.tuple(fc.constant(packAssets), arbInterruptIndex(packAssets.length)),
        ),
        async ([packAssets, interruptIdx]) => {
          const ctx = await setup();
          try {
            const bundleId = 'prop14-resume';
            const version = '1.0.0';
            const ref: PackRef = { bundleId, version };

            // Build assets and manifest.
            const assets: ManifestLockAsset[] = [];
            for (const a of packAssets) {
              const { asset, content } = makeAsset(a.path, a.content, {
                protected: a.protected,
              });
              assets.push(asset);
              ctx.http.addAsset(ref, a.path, content);
            }

            const signed = buildSignedManifest(ctx.privateKey, bundleId, version, assets);
            ctx.http.addManifest(ref, signed);

            // First attempt: interrupt at the chosen asset index.
            ctx.http.interruptAtAssetIndex = interruptIdx;
            const result1 = await ctx.downloader.download(bundleId, version);

            // The download may or may not fail depending on whether the
            // interrupted asset is the one that actually gets fetched
            // (already-complete assets are skipped). If it succeeded,
            // the interrupt didn't fire (asset was already on disk from
            // a prior run in the same test context — shouldn't happen
            // with fresh context, but handle gracefully).
            if (result1.ok) {
              // If it succeeded despite the interrupt, the pack is valid.
              const startable = await ctx.downloader.isPackStartable(bundleId, version);
              if (!startable) {
                throw new Error('Pack should be startable after successful download');
              }
              return; // Property holds trivially.
            }

            // Pack should NOT be startable after a failed download.
            const startableAfterFail = await ctx.downloader.isPackStartable(bundleId, version);
            if (startableAfterFail) {
              throw new Error('Pack should NOT be startable after a failed download');
            }

            // Resume: clear the interrupt and retry.
            ctx.http.interruptAtAssetIndex = null;
            ctx.http.resetCounters();

            const result2 = await ctx.downloader.download(bundleId, version);
            if (!result2.ok) {
              throw new Error(
                `Resume failed unexpectedly: ${result2.errors.map((e) => e.message).join(', ')}`,
              );
            }

            // Verify all on-disk content matches byte-for-byte.
            const finalDir = ctx.manager.packDir(ref);
            for (const a of packAssets) {
              const onDisk = await fs.readFile(path.join(finalDir, a.path));
              const expectedSha = crypto
                .createHash('sha256')
                .update(a.content)
                .digest('hex');
              const actualSha = crypto.createHash('sha256').update(onDisk).digest('hex');
              if (actualSha !== expectedSha) {
                throw new Error(
                  `SHA mismatch after resume for ${a.path}: expected ${expectedSha}, got ${actualSha}`,
                );
              }
            }

            // Pack should be startable after successful resume.
            const startable = await ctx.downloader.isPackStartable(bundleId, version);
            if (!startable) {
              throw new Error('Pack should be startable after successful resume');
            }
          } finally {
            await teardown(ctx);
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('resume does not re-fetch assets that are already complete', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPack.filter((assets) => assets.length >= 4).chain((packAssets) =>
          fc.tuple(
            fc.constant(packAssets),
            // Interrupt at an index >= 1 so at least one asset completes before the failure.
            fc.integer({ min: 1, max: packAssets.length - 1 }),
          ),
        ),
        async ([packAssets, interruptIdx]) => {
          const ctx = await setup();
          try {
            const bundleId = 'prop14-noredownload';
            const version = '1.0.0';
            const ref: PackRef = { bundleId, version };

            // Build assets and manifest.
            const assets: ManifestLockAsset[] = [];
            for (const a of packAssets) {
              const { asset, content } = makeAsset(a.path, a.content, {
                protected: a.protected,
              });
              assets.push(asset);
              ctx.http.addAsset(ref, a.path, content);
            }

            const signed = buildSignedManifest(ctx.privateKey, bundleId, version, assets);
            ctx.http.addManifest(ref, signed);

            // First attempt: interrupt at the chosen index.
            ctx.http.interruptAtAssetIndex = interruptIdx;
            const result1 = await ctx.downloader.download(bundleId, version);

            if (result1.ok) {
              // Interrupt didn't fire; property holds trivially.
              return;
            }

            // Identify which assets were successfully fetched before the interrupt.
            // These are the ones that have a fetch count > 0 AND whose status
            // in pack_progress is 'complete'.
            const completedBefore = new Set<string>();
            const rows = await ctx.manager.driver.all<{
              asset_path: string;
              status: string;
            }>(
              `SELECT asset_path, status FROM pack_progress
               WHERE bundle_id = ? AND version = ?`,
              [bundleId, version],
            );
            for (const row of rows) {
              if (row.status === 'complete') {
                completedBefore.add(row.asset_path);
              }
            }

            // Resume: clear interrupt and reset fetch counters.
            ctx.http.interruptAtAssetIndex = null;
            ctx.http.resetCounters();

            const result2 = await ctx.downloader.download(bundleId, version);
            if (!result2.ok) {
              throw new Error(
                `Resume failed: ${result2.errors.map((e) => e.message).join(', ')}`,
              );
            }

            // Verify: assets that were complete before the resume should NOT
            // have been re-fetched (fetch count = 0 for those keys).
            for (const completedPath of completedBefore) {
              const key = `${bundleId}@${version}/${completedPath}`;
              const fetches = ctx.http.fetchCount.get(key) ?? 0;
              if (fetches > 0) {
                throw new Error(
                  `Asset "${completedPath}" was already complete but was re-fetched ` +
                    `${fetches} time(s) during resume`,
                );
              }
            }
          } finally {
            await teardown(ctx);
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('a pack is not startable until all assets are complete', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPack.filter((assets) => assets.length >= 4).chain((packAssets) =>
          fc.tuple(
            fc.constant(packAssets),
            fc.integer({ min: 1, max: packAssets.length - 1 }),
          ),
        ),
        async ([packAssets, interruptIdx]) => {
          const ctx = await setup();
          try {
            const bundleId = 'prop14-nostart';
            const version = '1.0.0';
            const ref: PackRef = { bundleId, version };

            // Build assets and manifest.
            const assets: ManifestLockAsset[] = [];
            for (const a of packAssets) {
              const { asset, content } = makeAsset(a.path, a.content, {
                protected: a.protected,
              });
              assets.push(asset);
              ctx.http.addAsset(ref, a.path, content);
            }

            const signed = buildSignedManifest(ctx.privateKey, bundleId, version, assets);
            ctx.http.addManifest(ref, signed);

            // Interrupt the download so it's incomplete.
            ctx.http.interruptAtAssetIndex = interruptIdx;
            const result = await ctx.downloader.download(bundleId, version);

            if (result.ok) {
              // Interrupt didn't fire; the pack completed. Startable is fine.
              return;
            }

            // The pack MUST NOT be startable when the download is incomplete.
            const startable = await ctx.downloader.isPackStartable(bundleId, version);
            if (startable) {
              throw new Error(
                'Pack is startable despite incomplete download ' +
                  `(interrupted at asset index ${interruptIdx})`,
              );
            }
          } finally {
            await teardown(ctx);
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });
});
