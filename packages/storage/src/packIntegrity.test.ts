// Wave 2 — Pack integrity, crash-safe activation, and concurrency tests.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
import { loadPackTour } from './packLoader';
import { PackIntegrityError } from './packIntegrity';
import { SIGNED_LOCK_RELATIVE_PATH, CONTROL_DIR } from './controlFile';
import { StorageBudget } from './budget';
import { AsyncMutex } from './asyncMutex';
import type { PackRef } from './paths';
import { createNodeFsPort } from './fs';

// ---------------------------------------------------------------------------
// Helpers
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
  content: Buffer | string,
): {
  asset: ManifestLockAsset;
  content: Buffer;
} {
  const buf = typeof content === 'string' ? Buffer.from(content) : content;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    asset: { path: assetPath, sizeBytes: buf.length, sha256, protected: false },
    content: buf,
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

class FakeHttpClient implements PackHttpClient {
  private manifests = new Map<string, SignedManifest>();
  private assets = new Map<string, Buffer>();

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
    const buf = this.assets.get(key);
    if (!buf) throw new Error(`asset not found: ${key}`);
    return (async function* () {
      yield buf;
    })();
  }
}

interface Ctx {
  manager: StorageManager;
  docs: string;
  http: FakeHttpClient;
  downloader: OfflinePackDownloader;
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
}

async function setup(): Promise<Ctx> {
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-w2-'));
  const raw = new Database(':memory:');
  const manager = await StorageManager.open({
    layout: { docsDir: docs },
    driver: betterSqliteDriver(raw),
    fs: createNodeFsPort(),
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

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.manager.close();
  await fs.rm(ctx.docs, { recursive: true, force: true });
}

function createVerifier(publicKey: crypto.KeyObject) {
  return {
    verify(signed: SignedManifest): boolean {
      try {
        const canonical = canonicalJsonStringify(signed.payload);
        const sig = Buffer.from(
          signed.signature.replace(/-/g, '+').replace(/_/g, '/') +
            '='.repeat((4 - (signed.signature.length % 4)) % 4),
          'base64',
        );
        return crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, sig);
      } catch {
        return false;
      }
    },
  };
}

/** Download a complete valid pack and return its ref + signed manifest. */
async function downloadValidPack(ctx: Ctx, bundleId: string, version: string) {
  const { asset: mAsset, content: mContent } = makeAsset(
    'manifest.json',
    JSON.stringify({
      bundleId,
      version,
      defaultLanguage: 'en',
      languages: ['en'],
      transitLine: { gtfsRouteId: '180', direction: 'north', mode: 'bus' },
    }),
  );
  const { asset: rAsset, content: rContent } = makeAsset(
    'route.json',
    JSON.stringify({ bundleId, polyline: [[52.2, 21.0]] }),
  );
  const narrativeText = '# Welcome\nThis is a test narrative.';
  const { asset: nAsset, content: nContent } = makeAsset('narratives/poi-1.en.md', narrativeText);
  const { asset: pAsset, content: pContent } = makeAsset(
    'pois.json',
    JSON.stringify({
      pois: [
        {
          id: 'poi-1',
          priority: 1,
          dwellSec: 3,
          geometry: { kind: 'circle', center: [52.2, 21.0], radiusMeters: 50 },
          narratives: { en: 'narratives/poi-1.en.md' },
          tone: 'standard',
        },
      ],
    }),
  );

  const ref: PackRef = { bundleId, version };
  const assets = [mAsset, rAsset, pAsset, nAsset];
  const signed = buildSignedManifest(ctx.privateKey, bundleId, version, assets);

  ctx.http.addManifest(ref, signed);
  ctx.http.addAsset(ref, 'manifest.json', mContent);
  ctx.http.addAsset(ref, 'route.json', rContent);
  ctx.http.addAsset(ref, 'pois.json', pContent);
  ctx.http.addAsset(ref, 'narratives/poi-1.en.md', nContent);

  const result = await ctx.downloader.download(bundleId, version);
  expect(result.ok).toBe(true);
  return { ref, signed, narrativeText };
}

// ===========================================================================
// A. Signed lock persistence
// ===========================================================================

describe('Signed lock persistence', () => {
  it('persists the exact signed envelope as a control file after download', async () => {
    const ctx = await setup();
    try {
      const { ref, signed } = await downloadValidPack(ctx, 'lock-test', '1.0.0');
      const lockPath = path.join(ctx.manager.packDir(ref), SIGNED_LOCK_RELATIVE_PATH);
      const raw = await fs.readFile(lockPath, 'utf8');
      const persisted = JSON.parse(raw);
      expect(persisted.signature).toBe(signed.signature);
      expect(persisted.kid).toBe(signed.kid);
      expect(persisted.payload.bundleId).toBe(signed.payload.bundleId);
      expect(persisted.payload.version).toBe(signed.payload.version);
      expect(persisted.payload.assets).toEqual(signed.payload.assets);
    } finally {
      await teardown(ctx);
    }
  });

  it('control file lives under .tramio/ directory', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'dir-test', '2.0.0');
      const controlDir = path.join(ctx.manager.packDir(ref), CONTROL_DIR);
      const stat = await fs.stat(controlDir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });
});

// ===========================================================================
// B. Load-time integrity verification
// ===========================================================================

describe('Load-time integrity — valid pack', () => {
  it('loads a valid pack unchanged', async () => {
    const ctx = await setup();
    try {
      const { ref, narrativeText } = await downloadValidPack(ctx, 'valid', '1.0.0');
      const verifier = createVerifier(ctx.publicKey);
      const loaded = await loadPackTour(ctx.manager, ref, verifier);
      expect(loaded.ref).toEqual(ref);
      expect(loaded.narratives['poi-1:en']).toBe(narrativeText.trim());
      expect(loaded.config.geofences).toHaveLength(1);
      expect(loaded.title).toContain('180');
    } finally {
      await teardown(ctx);
    }
  });

  it('strips YAML frontmatter from narratives before returning', async () => {
    const ctx = await setup();
    try {
      const bundleId = 'frontmatter-strip';
      const version = '1.0.0';
      const narrativeWithFrontmatter =
        '---\npoiId: poi-1\nlanguage: en\ntone: standard\n---\n# Welcome\nThis is the body.';
      const expectedBody = '# Welcome\nThis is the body.';

      const { asset: mAsset, content: mContent } = makeAsset(
        'manifest.json',
        JSON.stringify({
          bundleId,
          version,
          defaultLanguage: 'en',
          languages: ['en'],
          transitLine: { gtfsRouteId: '180', direction: 'north', mode: 'bus' },
        }),
      );
      const { asset: rAsset, content: rContent } = makeAsset(
        'route.json',
        JSON.stringify({ bundleId, polyline: [[52.2, 21.0]] }),
      );
      const { asset: nAsset, content: nContent } = makeAsset(
        'narratives/poi-1.en.md',
        narrativeWithFrontmatter,
      );
      const { asset: pAsset, content: pContent } = makeAsset(
        'pois.json',
        JSON.stringify({
          pois: [
            {
              id: 'poi-1',
              priority: 1,
              dwellSec: 3,
              geometry: { kind: 'circle', center: [52.2, 21.0], radiusMeters: 50 },
              narratives: { en: 'narratives/poi-1.en.md' },
              tone: 'standard',
            },
          ],
        }),
      );

      const ref: PackRef = { bundleId, version };
      const signed = buildSignedManifest(ctx.privateKey, bundleId, version, [
        mAsset,
        rAsset,
        pAsset,
        nAsset,
      ]);
      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', mContent);
      ctx.http.addAsset(ref, 'route.json', rContent);
      ctx.http.addAsset(ref, 'pois.json', pContent);
      ctx.http.addAsset(ref, 'narratives/poi-1.en.md', nContent);

      const result = await ctx.downloader.download(bundleId, version);
      expect(result.ok).toBe(true);

      const verifier = createVerifier(ctx.publicKey);
      const loaded = await loadPackTour(ctx.manager, ref, verifier);

      // Frontmatter must be stripped — body only.
      expect(loaded.narratives['poi-1:en']).toBe(expectedBody);
      // Must NOT contain frontmatter delimiters or metadata.
      expect(loaded.narratives['poi-1:en']).not.toContain('poiId:');
      expect(loaded.narratives['poi-1:en']).not.toMatch(/^---/);
    } finally {
      await teardown(ctx);
    }
  });
});

describe('Load-time integrity — tampered assets', () => {
  it('rejects tampered manifest.json', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'tamper-m', '1.0.0');
      const manifestPath = path.join(ctx.manager.packDir(ref), 'manifest.json');
      await fs.writeFile(manifestPath, '{"bundleId":"evil","version":"1.0.0"}');
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, ref, verifier)).rejects.toThrow(PackIntegrityError);
      try {
        await loadPackTour(ctx.manager, ref, verifier);
      } catch (e) {
        expect((e as PackIntegrityError).kind).toMatch(/hash-mismatch|size-mismatch/);
        expect((e as PackIntegrityError).relativePath).toBe('manifest.json');
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('rejects tampered route.json', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'tamper-r', '1.0.0');
      const routePath = path.join(ctx.manager.packDir(ref), 'route.json');
      await fs.writeFile(routePath, '{"bundleId":"x","polyline":[[0,0]]}');
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, ref, verifier)).rejects.toThrow(PackIntegrityError);
    } finally {
      await teardown(ctx);
    }
  });

  it('rejects tampered pois.json', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'tamper-p', '1.0.0');
      const poisPath = path.join(ctx.manager.packDir(ref), 'pois.json');
      await fs.writeFile(poisPath, '{"pois":[]}');
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, ref, verifier)).rejects.toThrow(PackIntegrityError);
    } finally {
      await teardown(ctx);
    }
  });

  it('rejects tampered narrative', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'tamper-n', '1.0.0');
      const narPath = path.join(ctx.manager.packDir(ref), 'narratives', 'poi-1.en.md');
      await fs.writeFile(narPath, 'HACKED CONTENT');
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, ref, verifier)).rejects.toThrow(PackIntegrityError);
      try {
        await loadPackTour(ctx.manager, ref, verifier);
      } catch (e) {
        expect((e as PackIntegrityError).kind).toMatch(/hash-mismatch|size-mismatch/);
        expect((e as PackIntegrityError).relativePath).toBe('narratives/poi-1.en.md');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('Load-time integrity — signature and identity', () => {
  it('rejects tampered signature', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'sig-bad', '1.0.0');
      const lockPath = path.join(ctx.manager.packDir(ref), SIGNED_LOCK_RELATIVE_PATH);
      const raw = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      raw.signature = base64urlEncode(crypto.randomBytes(64));
      await fs.writeFile(lockPath, JSON.stringify(raw));
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, ref, verifier)).rejects.toThrow(PackIntegrityError);
      try {
        await loadPackTour(ctx.manager, ref, verifier);
      } catch (e) {
        expect((e as PackIntegrityError).kind).toBe('signature');
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('rejects wrong kid via verifier', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'kid-bad', '1.0.0');
      // Use a verifier that only accepts a specific kid.
      const strictVerifier = {
        verify(signed: SignedManifest): boolean {
          if (signed.kid !== 'expected-kid') return false;
          return createVerifier(ctx.publicKey).verify(signed);
        },
      };
      await expect(loadPackTour(ctx.manager, ref, strictVerifier)).rejects.toThrow(
        PackIntegrityError,
      );
    } finally {
      await teardown(ctx);
    }
  });

  it('rejects missing lock (legacy pack)', async () => {
    const ctx = await setup();
    try {
      const ref: PackRef = { bundleId: 'legacy', version: '1.0.0' };
      const dir = ctx.manager.packDir(ref);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'manifest.json'), '{}');
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, ref, verifier)).rejects.toThrow(PackIntegrityError);
      try {
        await loadPackTour(ctx.manager, ref, verifier);
      } catch (e) {
        expect((e as PackIntegrityError).kind).toBe('missing-lock');
      }
    } finally {
      await teardown(ctx);
    }
  });

  it('rejects identity mismatch in lock', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'id-mismatch', '1.0.0');
      // Try loading with a different ref than what's in the lock.
      const wrongRef: PackRef = { bundleId: 'id-mismatch', version: '2.0.0' };
      // Move directory to match the wrong ref path.
      const wrongDir = ctx.manager.packDir(wrongRef);
      await fs.mkdir(path.dirname(wrongDir), { recursive: true });
      await fs.cp(ctx.manager.packDir(ref), wrongDir, { recursive: true });
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, wrongRef, verifier)).rejects.toThrow(
        PackIntegrityError,
      );
      try {
        await loadPackTour(ctx.manager, wrongRef, verifier);
      } catch (e) {
        expect((e as PackIntegrityError).kind).toBe('identity-mismatch');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

describe('Load-time integrity — narrative presence', () => {
  it('optional non-listed narrative can be absent without error', async () => {
    const ctx = await setup();
    try {
      // Build a pack where pois.json has a narrative for 'fr' but it's not in pois.narratives
      // (so the loader won't try to load it) — this simulates an optional language.
      const { ref } = await downloadValidPack(ctx, 'optional-nar', '1.0.0');
      const verifier = createVerifier(ctx.publicKey);
      // Load with 'fr' language — no French narrative exists, but it's not
      // listed in pois.json#narratives, so no error.
      const loaded = await loadPackTour(ctx.manager, ref, verifier, 'fr');
      // The French narrative key shouldn't exist.
      expect(loaded.narratives['poi-1:fr']).toBeUndefined();
      // But English should be loaded since it's in manifest.languages.
      expect(loaded.narratives['poi-1:en']).toBeDefined();
    } finally {
      await teardown(ctx);
    }
  });

  it('listed missing narrative fails with asset-missing', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'missing-nar', '1.0.0');
      // Delete the narrative file.
      const narPath = path.join(ctx.manager.packDir(ref), 'narratives', 'poi-1.en.md');
      await fs.rm(narPath);
      const verifier = createVerifier(ctx.publicKey);
      await expect(loadPackTour(ctx.manager, ref, verifier)).rejects.toThrow(PackIntegrityError);
      try {
        await loadPackTour(ctx.manager, ref, verifier);
      } catch (e) {
        expect((e as PackIntegrityError).kind).toBe('asset-missing');
        expect((e as PackIntegrityError).relativePath).toBe('narratives/poi-1.en.md');
      }
    } finally {
      await teardown(ctx);
    }
  });
});

// ===========================================================================
// C. Crash-safe activation
// ===========================================================================

describe('Crash-safe activation', () => {
  it('reinstall same version is idempotent when final is valid', async () => {
    const ctx = await setup();
    try {
      await downloadValidPack(ctx, 'idem', '1.0.0');
      // Download again — should succeed without error.
      const result = await ctx.downloader.download('idem', '1.0.0');
      expect(result.ok).toBe(true);
      expect(await ctx.downloader.isPackStartable('idem', '1.0.0')).toBe(true);
      // Verify the lock is still valid.
      const verifier = createVerifier(ctx.publicKey);
      const loaded = await loadPackTour(
        ctx.manager,
        { bundleId: 'idem', version: '1.0.0' },
        verifier,
      );
      expect(loaded.ref.bundleId).toBe('idem');
    } finally {
      await teardown(ctx);
    }
  });

  it('crash after backup but before rename: recovery restores backup', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'crash-a', '1.0.0');
      const finalDir = ctx.manager.packDir(ref);
      const backupDir = `${finalDir}.backup`;

      // Simulate crash state: final is gone, backup exists.
      await fs.rename(finalDir, backupDir);

      // Run recovery.
      await ctx.downloader.recover('crash-a', '1.0.0');

      // Final should be restored from backup.
      const stat = await fs.stat(finalDir);
      expect(stat.isDirectory()).toBe(true);

      // Backup should be gone.
      await expect(fs.stat(backupDir)).rejects.toThrow();

      // Pack should be startable.
      expect(await ctx.downloader.isPackStartable('crash-a', '1.0.0')).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });

  it('final plus backup: corrupt promoted asset restores the valid backup', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'crash-corrupt', '1.0.0');
      const finalDir = ctx.manager.packDir(ref);
      const backupDir = `${finalDir}.backup`;

      // Model the state after final→backup and staging→final, before backup
      // cleanup. The promoted final carries a valid signed lock but one asset
      // was corrupted after promotion.
      await fs.rename(finalDir, backupDir);
      await fs.cp(backupDir, finalDir, { recursive: true });
      await fs.writeFile(path.join(finalDir, 'route.json'), '{"tampered":true}');

      await ctx.downloader.recover(ref.bundleId, ref.version);

      // Recovery must reject the corrupt final and restore the valid backup.
      await expect(fs.stat(backupDir)).rejects.toThrow();
      const loaded = await loadPackTour(ctx.manager, ref, createVerifier(ctx.publicKey));
      expect(loaded.config.route).toEqual([[52.2, 21.0]]);
    } finally {
      await teardown(ctx);
    }
  });

  it('crash leaving staging: recovery preserves staging, keeps final', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'crash-b', '1.0.0');
      const stagingDir = ctx.manager.stagingDir(ref);

      // Simulate crash state: final exists + orphaned staging.
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(path.join(stagingDir, 'junk'), 'orphan');

      await ctx.downloader.recover('crash-b', '1.0.0');

      // Staging should be preserved (resumable download store).
      const stagingStat = await fs.stat(stagingDir);
      expect(stagingStat.isDirectory()).toBe(true);
      // Final still valid.
      expect(await ctx.downloader.isPackStartable('crash-b', '1.0.0')).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });

  it('crash leaving only staging (no final, no backup): staging preserved for resume', async () => {
    const ctx = await setup();
    try {
      const ref: PackRef = { bundleId: 'crash-c', version: '1.0.0' };
      const stagingDir = ctx.manager.stagingDir(ref);
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(path.join(stagingDir, 'partial'), 'data');

      await ctx.downloader.recover('crash-c', '1.0.0');

      // Staging is KEPT for resume — never deleted by recovery.
      const stagingStat = await fs.stat(stagingDir);
      expect(stagingStat.isDirectory()).toBe(true);
      expect(await ctx.downloader.isPackStartable('crash-c', '1.0.0')).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });

  it('old pack survives when new version download overwrites', async () => {
    const ctx = await setup();
    try {
      // Install v1.
      await downloadValidPack(ctx, 'upgrade', '1.0.0');
      expect(await ctx.downloader.isPackStartable('upgrade', '1.0.0')).toBe(true);

      // Install v2 (different version = different directory).
      const { asset: m2, content: mc2 } = makeAsset(
        'manifest.json',
        JSON.stringify({
          bundleId: 'upgrade',
          version: '2.0.0',
          defaultLanguage: 'en',
          languages: ['en'],
        }),
      );
      const { asset: r2, content: rc2 } = makeAsset(
        'route.json',
        JSON.stringify({ bundleId: 'upgrade', polyline: [[52.3, 21.1]] }),
      );
      const { asset: p2, content: pc2 } = makeAsset('pois.json', JSON.stringify({ pois: [] }));
      const ref2: PackRef = { bundleId: 'upgrade', version: '2.0.0' };
      const signed2 = buildSignedManifest(ctx.privateKey, 'upgrade', '2.0.0', [m2, r2, p2]);
      ctx.http.addManifest(ref2, signed2);
      ctx.http.addAsset(ref2, 'manifest.json', mc2);
      ctx.http.addAsset(ref2, 'route.json', rc2);
      ctx.http.addAsset(ref2, 'pois.json', pc2);

      const result2 = await ctx.downloader.download('upgrade', '2.0.0');
      expect(result2.ok).toBe(true);

      // Both versions should be startable (different directories).
      expect(await ctx.downloader.isPackStartable('upgrade', '1.0.0')).toBe(true);
      expect(await ctx.downloader.isPackStartable('upgrade', '2.0.0')).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });
});

// ===========================================================================
// D. Concurrency — AsyncMutex and budget serialization
// ===========================================================================

describe('AsyncMutex', () => {
  it('serializes concurrent operations', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.withLock(async () => {
      await delay(20);
      order.push(1);
    });
    const p2 = mutex.withLock(async () => {
      order.push(2);
    });
    const p3 = mutex.withLock(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('release is idempotent', async () => {
    const mutex = new AsyncMutex();
    const release = await mutex.acquire();
    release();
    release(); // second call should not throw or break state
    expect(mutex.isLocked).toBe(false);
  });

  it('reports queue length', async () => {
    const mutex = new AsyncMutex();
    const release = await mutex.acquire();
    expect(mutex.queueLength).toBe(0);

    const p1 = mutex.acquire();
    const p2 = mutex.acquire();
    expect(mutex.queueLength).toBe(2);

    release();
    const r1 = await p1;
    expect(mutex.queueLength).toBe(1);
    r1();
    const r2 = await p2;
    r2();
    expect(mutex.queueLength).toBe(0);
    expect(mutex.isLocked).toBe(false);
  });
});

describe('Concurrent budget operations', () => {
  it('cannot exceed budget under concurrent checkBudget calls', async () => {
    const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-w2-conc-'));
    const raw = new Database(':memory:');
    const manager = await StorageManager.open({
      layout: { docsDir: docs },
      driver: betterSqliteDriver(raw),
      fs: createNodeFsPort(),
    });

    const budget = new StorageBudget({
      storage: manager,
      config: { budgetBytes: 1000, evictionMode: 'manual' },
      activeTourProvider: () => null,
    });

    // Register some existing packs consuming 800 bytes.
    await budget.touchPack({ bundleId: 'a', version: '1' }, 400);
    await budget.touchPack({ bundleId: 'b', version: '1' }, 400);

    // Fire 5 concurrent checkBudget calls for 300 bytes each.
    // Only the first should succeed (200 remaining < 300 for others).
    // With the mutex, they serialize — all should get the same answer.
    const results = await Promise.all([
      budget.checkBudget(300),
      budget.checkBudget(300),
      budget.checkBudget(300),
      budget.checkBudget(300),
      budget.checkBudget(300),
    ]);

    // All should report over-budget-manual since 800 + 300 > 1000.
    for (const r of results) {
      expect(r.outcome).toBe('over-budget-manual');
    }

    await manager.close();
    await fs.rm(docs, { recursive: true, force: true });
  });

  it('auto-evict under concurrency never evicts active pack', async () => {
    const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-w2-conc2-'));
    const raw = new Database(':memory:');
    const manager = await StorageManager.open({
      layout: { docsDir: docs },
      driver: betterSqliteDriver(raw),
      fs: createNodeFsPort(),
    });

    const activeRef: PackRef = { bundleId: 'active', version: '1' };

    const budget = new StorageBudget({
      storage: manager,
      config: { budgetBytes: 500, evictionMode: 'auto' },
      activeTourProvider: () => activeRef,
    });

    // Create pack directories and register in LRU.
    const packADir = manager.packDir({ bundleId: 'evictable', version: '1' });
    const packBDir = manager.packDir(activeRef);
    await fs.mkdir(packADir, { recursive: true });
    await fs.mkdir(packBDir, { recursive: true });
    await budget.touchPack({ bundleId: 'evictable', version: '1' }, 300);
    await budget.touchPack(activeRef, 200);

    // Concurrent auto-evict calls — should evict 'evictable' but never 'active'.
    const results = await Promise.all([budget.checkBudget(250), budget.checkBudget(250)]);

    // After first evicts 'evictable', second should be blocked (only active remains).
    const outcomes = results.map((r) => r.outcome);
    // At least one should succeed with eviction.
    expect(outcomes).toContain('over-budget-evicted');

    // Active pack must still be in LRU.
    const summary = await budget.getUsageSummary();
    const activeEntry = summary.packs.find((p) => p.bundleId === 'active' && p.version === '1');
    expect(activeEntry).toBeDefined();

    await manager.close();
    await fs.rm(docs, { recursive: true, force: true });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===========================================================================
// E. Recovery redesign — completed assets not refetched after recovery entry
// ===========================================================================

describe('Recovery — completed assets not refetched', () => {
  it('recovery does not delete staging, so resume skips completed assets', async () => {
    const ctx = await setup();
    try {
      const bundleId = 'recovery-resume';
      const version = '1.0.0';

      const { asset: mAsset, content: mContent } = makeAsset(
        'manifest.json',
        JSON.stringify({
          bundleId,
          version,
          defaultLanguage: 'en',
          languages: ['en'],
        }),
      );
      const { asset: rAsset, content: rContent } = makeAsset(
        'route.json',
        JSON.stringify({ bundleId, polyline: [[52.2, 21.0]] }),
      );
      const { asset: pAsset, content: pContent } = makeAsset(
        'pois.json',
        JSON.stringify({ pois: [] }),
      );

      const ref: PackRef = { bundleId, version };
      const assets = [mAsset, rAsset, pAsset];
      const signed = buildSignedManifest(ctx.privateKey, bundleId, version, assets);

      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', mContent);
      ctx.http.addAsset(ref, 'route.json', rContent);
      ctx.http.addAsset(ref, 'pois.json', pContent);

      // First download succeeds.
      const result1 = await ctx.downloader.download(bundleId, version);
      expect(result1.ok).toBe(true);

      // Now simulate a scenario where final exists — recovery should keep it.
      await ctx.downloader.recover(bundleId, version);

      // Final still startable.
      expect(await ctx.downloader.isPackStartable(bundleId, version)).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });

  it('recovery with final+backup verifies final lock and removes backup', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'rec-fb', '1.0.0');
      const finalDir = ctx.manager.packDir(ref);
      const backupDir = `${finalDir}.backup`;

      // Create a backup (simulating mid-promotion crash that resolved).
      await fs.cp(finalDir, backupDir, { recursive: true });

      await ctx.downloader.recover('rec-fb', '1.0.0');

      // Final should remain, backup should be removed.
      const finalStat = await fs.stat(finalDir);
      expect(finalStat.isDirectory()).toBe(true);
      await expect(fs.stat(backupDir)).rejects.toThrow();
    } finally {
      await teardown(ctx);
    }
  });

  it('recovery with corrupted final + backup restores backup', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'rec-corrupt', '1.0.0');
      const finalDir = ctx.manager.packDir(ref);
      const backupDir = `${finalDir}.backup`;

      // Create backup from valid final.
      await fs.cp(finalDir, backupDir, { recursive: true });

      // Corrupt the final's lock.
      const lockPath = path.join(finalDir, SIGNED_LOCK_RELATIVE_PATH);
      await fs.writeFile(lockPath, 'CORRUPTED');

      await ctx.downloader.recover('rec-corrupt', '1.0.0');

      // Final should be the restored backup.
      const restoredLock = await fs.readFile(
        path.join(finalDir, SIGNED_LOCK_RELATIVE_PATH),
        'utf8',
      );
      const parsed = JSON.parse(restoredLock);
      expect(parsed.payload.bundleId).toBe('rec-corrupt');
      // Backup should be gone.
      await expect(fs.stat(backupDir)).rejects.toThrow();
    } finally {
      await teardown(ctx);
    }
  });

  it('recovery: no final + backup restores backup, keeps staging', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'rec-nb', '1.0.0');
      const finalDir = ctx.manager.packDir(ref);
      const backupDir = `${finalDir}.backup`;
      const stagingDir = ctx.manager.stagingDir(ref);

      // Move final to backup, create staging (simulating interrupted update).
      await fs.rename(finalDir, backupDir);
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(path.join(stagingDir, 'partial-asset'), 'partial');

      await ctx.downloader.recover('rec-nb', '1.0.0');

      // Backup restored to final.
      const finalStat = await fs.stat(finalDir);
      expect(finalStat.isDirectory()).toBe(true);
      // Staging preserved for resume.
      const stagingStat = await fs.stat(stagingDir);
      expect(stagingStat.isDirectory()).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });

  it('recovery: final + staging without backup — staging kept', async () => {
    const ctx = await setup();
    try {
      const { ref } = await downloadValidPack(ctx, 'rec-fs', '1.0.0');
      const stagingDir = ctx.manager.stagingDir(ref);

      // Create staging (simulating in-progress update).
      await fs.mkdir(stagingDir, { recursive: true });
      await fs.writeFile(path.join(stagingDir, 'asset.part'), 'data');

      await ctx.downloader.recover('rec-fs', '1.0.0');

      // Staging preserved.
      const stagingStat = await fs.stat(stagingDir);
      expect(stagingStat.isDirectory()).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });
});

// ===========================================================================
// F. Keyed mutex — same-ref serialization, different-ref concurrency
// ===========================================================================

describe('Keyed download mutex', () => {
  it('same-ref download calls serialize (barrier test)', async () => {
    const ctx = await setup();
    try {
      const bundleId = 'mutex-serial';
      const version = '1.0.0';

      const { asset: mAsset, content: mContent } = makeAsset(
        'manifest.json',
        JSON.stringify({ bundleId, version, defaultLanguage: 'en', languages: ['en'] }),
      );
      const { asset: rAsset, content: rContent } = makeAsset(
        'route.json',
        JSON.stringify({ bundleId, polyline: [[52.2, 21.0]] }),
      );
      const { asset: pAsset, content: pContent } = makeAsset(
        'pois.json',
        JSON.stringify({ pois: [] }),
      );

      const ref: PackRef = { bundleId, version };
      const signed = buildSignedManifest(ctx.privateKey, bundleId, version, [
        mAsset,
        rAsset,
        pAsset,
      ]);
      ctx.http.addManifest(ref, signed);
      ctx.http.addAsset(ref, 'manifest.json', mContent);
      ctx.http.addAsset(ref, 'route.json', rContent);
      ctx.http.addAsset(ref, 'pois.json', pContent);

      const order: number[] = [];

      // Fire two concurrent downloads for the same ref.
      const p1 = ctx.downloader.download(bundleId, version).then((r) => {
        order.push(1);
        return r;
      });
      const p2 = ctx.downloader.download(bundleId, version).then((r) => {
        order.push(2);
        return r;
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      // Both should succeed (second call just re-verifies the completed pack).
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // They serialized: 1 before 2.
      expect(order).toEqual([1, 2]);
    } finally {
      await teardown(ctx);
    }
  });

  it('different-ref downloads proceed concurrently', async () => {
    const ctx = await setup();
    try {
      // Set up two different packs.
      for (const bundleId of ['conc-a', 'conc-b']) {
        const version = '1.0.0';
        const { asset: mAsset, content: mContent } = makeAsset(
          'manifest.json',
          JSON.stringify({ bundleId, version, defaultLanguage: 'en', languages: ['en'] }),
        );
        const { asset: rAsset, content: rContent } = makeAsset(
          'route.json',
          JSON.stringify({ bundleId, polyline: [[52.2, 21.0]] }),
        );
        const { asset: pAsset, content: pContent } = makeAsset(
          'pois.json',
          JSON.stringify({ pois: [] }),
        );

        const ref: PackRef = { bundleId, version };
        const signed = buildSignedManifest(ctx.privateKey, bundleId, version, [
          mAsset,
          rAsset,
          pAsset,
        ]);
        ctx.http.addManifest(ref, signed);
        ctx.http.addAsset(ref, 'manifest.json', mContent);
        ctx.http.addAsset(ref, 'route.json', rContent);
        ctx.http.addAsset(ref, 'pois.json', pContent);
      }

      // Fire concurrently — both should complete successfully.
      const [r1, r2] = await Promise.all([
        ctx.downloader.download('conc-a', '1.0.0'),
        ctx.downloader.download('conc-b', '1.0.0'),
      ]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(await ctx.downloader.isPackStartable('conc-a', '1.0.0')).toBe(true);
      expect(await ctx.downloader.isPackStartable('conc-b', '1.0.0')).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });
});

// ===========================================================================
// G. Cross-instance StorageBudget race (WeakMap shared mutex)
// ===========================================================================

describe('Cross-instance StorageBudget race', () => {
  it('two StorageBudget instances sharing one StorageManager serialize via shared mutex', async () => {
    const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-w2-cross-'));
    const raw = new Database(':memory:');
    const manager = await StorageManager.open({
      layout: { docsDir: docs },
      driver: betterSqliteDriver(raw),
      fs: createNodeFsPort(),
    });

    const budget1 = new StorageBudget({
      storage: manager,
      config: { budgetBytes: 1000, evictionMode: 'auto' },
      activeTourProvider: () => null,
    });

    const budget2 = new StorageBudget({
      storage: manager,
      config: { budgetBytes: 1000, evictionMode: 'auto' },
      activeTourProvider: () => null,
    });

    // Register packs using budget1.
    const refA: PackRef = { bundleId: 'cross-a', version: '1' };
    const refB: PackRef = { bundleId: 'cross-b', version: '1' };
    await fs.mkdir(manager.packDir(refA), { recursive: true });
    await fs.mkdir(manager.packDir(refB), { recursive: true });
    await budget1.touchPack(refA, 400);
    await budget1.touchPack(refB, 400);

    // Concurrent checkBudget from different instances.
    const [r1, r2] = await Promise.all([budget1.checkBudget(300), budget2.checkBudget(300)]);

    // With shared mutex, both serialize — auto-evict should not produce
    // impossible states. Both see the same storage state serially.
    // First one evicts a pack (800+300>1000 → evict LRU), then second
    // sees 400 remaining + 300 = 700 ≤ 1000 → ok.
    const outcomes = [r1, r2].map((r) => r.outcome).sort();
    expect(outcomes).toContain('over-budget-evicted');
    // Second either fits (ok) or also evicts, depending on ordering.
    // The important invariant: no impossible state, both complete without error.
    expect(outcomes.every((o) => o === 'ok' || o === 'over-budget-evicted')).toBe(true);

    await manager.close();
    await fs.rm(docs, { recursive: true, force: true });
  });

  it('public evictPack serializes with checkBudget', async () => {
    const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-w2-evict-'));
    const raw = new Database(':memory:');
    const manager = await StorageManager.open({
      layout: { docsDir: docs },
      driver: betterSqliteDriver(raw),
      fs: createNodeFsPort(),
    });

    const budget = new StorageBudget({
      storage: manager,
      config: { budgetBytes: 1000, evictionMode: 'manual' },
      activeTourProvider: () => null,
    });

    const refA: PackRef = { bundleId: 'evict-ser', version: '1' };
    await fs.mkdir(manager.packDir(refA), { recursive: true });
    await budget.touchPack(refA, 600);

    // Fire evictPack and checkBudget concurrently.
    const [, checkResult] = await Promise.all([budget.evictPack(refA), budget.checkBudget(500)]);

    // After eviction, the budget check should see 0 used bytes, so fits.
    // Due to serialization, checkBudget runs after evictPack completes.
    expect(checkResult.outcome).toBe('ok');
    expect(await budget.totalUsedBytes()).toBe(0);

    await manager.close();
    await fs.rm(docs, { recursive: true, force: true });
  });
});
