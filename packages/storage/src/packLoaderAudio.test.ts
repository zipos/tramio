// Wave 3 — Pack loader pre-rendered audio verification tests.
//
// Validates:
//   - Valid audio files in lock are exposed in mediaCatalog with absolute paths.
//   - Tampered audio (hash mismatch) throws PackIntegrityError (fail closed).
//   - Missing audio files throw PackIntegrityError (fail closed).
//   - Unlisted audio (not in lock) throws PackIntegrityError (fail closed).
//   - One language tampered while another is valid → rejects entire load.
//   - Language fallback catalog is correct (only verified entries appear).

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { StorageManager } from './manager';
import { betterSqliteDriver } from './sqlite';
import {
  canonicalJsonStringify,
  type ManifestLockAsset,
  type ManifestLockPayload,
  type SignedManifest,
} from './downloader';
import { loadPackTour } from './packLoader';
import { PackIntegrityError } from './packIntegrity';
import { SIGNED_LOCK_RELATIVE_PATH, CONTROL_DIR } from './controlFile';
import { createNodeFsPort } from './fs';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

async function setupPack(tmpDir: string, privateKey: crypto.KeyObject) {
  const bundleId = 'test-audio-pack';
  const version = '1.0.0';
  const packRoot = path.join(tmpDir, 'packs', bundleId, version);

  // Core files content.
  const manifestContent = JSON.stringify({
    bundleId,
    version,
    defaultLanguage: 'en',
    languages: ['en', 'pl'],
    transitLine: { gtfsRouteId: '42', direction: 'north', mode: 'bus' },
  });
  const routeContent = JSON.stringify({
    bundleId,
    polyline: [
      [51.0, 17.0],
      [51.1, 17.1],
    ],
  });

  // Audio file contents (fake AAC bytes).
  const audioEnContent = Buffer.from([0xff, 0xf1, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  const audioPlContent = Buffer.from([0xff, 0xf1, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15]);

  // Narrative files.
  const narrativeEn = '---\nreview:\n  status: approved\n---\nA beautiful palace.';
  const narrativePl = '---\nreview:\n  status: approved\n---\nPiękny pałac.';

  const poisContent = JSON.stringify({
    pois: [
      {
        id: 'poi-palace',
        priority: 90,
        geometry: { kind: 'circle', center: [51.0, 17.0], radiusMeters: 50 },
        dwellSec: 3,
        narratives: {
          en: 'narratives/en/poi-palace.md',
          pl: 'narratives/pl/poi-palace.md',
        },
        audio: { en: 'audio/poi-palace.en.m4a', pl: 'audio/poi-palace.pl.m4a' },
        tone: 'standard',
      },
      {
        id: 'poi-park',
        priority: 80,
        geometry: { kind: 'circle', center: [51.05, 17.05], radiusMeters: 40 },
        dwellSec: 3,
        narratives: { en: 'narratives/en/poi-park.md' },
        tone: 'standard',
      },
    ],
  });

  const manifestAsset = makeAsset('manifest.json', manifestContent);
  const routeAsset = makeAsset('route.json', routeContent);
  const poisAsset = makeAsset('pois.json', poisContent);
  const audioEnAsset = makeAsset('audio/poi-palace.en.m4a', audioEnContent);
  const audioPlAsset = makeAsset('audio/poi-palace.pl.m4a', audioPlContent);
  const narrativeEnAsset = makeAsset('narratives/en/poi-palace.md', narrativeEn);
  const narrativePlAsset = makeAsset('narratives/pl/poi-palace.md', narrativePl);
  const narrativeParkAsset = makeAsset(
    'narratives/en/poi-park.md',
    '---\nreview:\n  status: approved\n---\nA lovely park.',
  );

  const allAssets = [
    manifestAsset,
    routeAsset,
    poisAsset,
    audioEnAsset,
    audioPlAsset,
    narrativeEnAsset,
    narrativePlAsset,
    narrativeParkAsset,
  ];

  // Write files.
  await fs.mkdir(packRoot, { recursive: true });
  await fs.mkdir(path.join(packRoot, CONTROL_DIR), { recursive: true });
  await fs.mkdir(path.join(packRoot, 'audio'), { recursive: true });
  await fs.mkdir(path.join(packRoot, 'narratives', 'en'), { recursive: true });
  await fs.mkdir(path.join(packRoot, 'narratives', 'pl'), { recursive: true });

  for (const { asset, content } of allAssets) {
    await fs.writeFile(path.join(packRoot, asset.path), content);
  }

  // Build and write signed lock.
  const signed = buildSignedManifest(
    privateKey,
    bundleId,
    version,
    allAssets.map((a) => a.asset),
  );
  await fs.writeFile(path.join(packRoot, SIGNED_LOCK_RELATIVE_PATH), JSON.stringify(signed));

  return {
    bundleId,
    version,
    packRoot,
    signed,
    allAssets,
    audioEnContent,
    audioPlContent,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadPackTour — pre-rendered audio verification (Wave 3)', () => {
  let tmpDir: string;
  let storage: StorageManager;
  let privateKey: crypto.KeyObject;
  let publicKey: crypto.KeyObject;

  beforeAll(async () => {
    const pair = generateKeyPair();
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-audio-'));
    const db = new Database(':memory:');
    const fsPort = createNodeFsPort();
    storage = await StorageManager.open({
      layout: { docsDir: tmpDir },
      driver: betterSqliteDriver(db),
      fs: fsPort,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const verifier = {
    verify: async (signed: SignedManifest) => {
      const msg = Buffer.from(canonicalJsonStringify(signed.payload), 'utf8');
      const sig = Buffer.from(
        signed.signature.replace(/-/g, '+').replace(/_/g, '/') + '==',
        'base64',
      );
      return crypto.verify(null, msg, publicKey, sig);
    },
  };

  it('exposes verified audio in mediaCatalog with absolute paths', async () => {
    const { bundleId, version, packRoot } = await setupPack(tmpDir, privateKey);
    const result = await loadPackTour(storage, { bundleId, version }, verifier, 'pl');

    // Audio should be in catalog.
    const poiPalace = result.mediaCatalog.pois['poi-palace'];
    expect(poiPalace).toBeDefined();
    expect(poiPalace!.audio['en']).toBe(path.join(packRoot, 'audio/poi-palace.en.m4a'));
    expect(poiPalace!.audio['pl']).toBe(path.join(packRoot, 'audio/poi-palace.pl.m4a'));
    expect(poiPalace!.narratives['en']).toBe('poi-palace:en');
    expect(poiPalace!.narratives['pl']).toBe('poi-palace:pl');
  });

  it('POI without audio has empty audio map in catalog', async () => {
    await setupPack(tmpDir, privateKey);
    const result = await loadPackTour(
      storage,
      { bundleId: 'test-audio-pack', version: '1.0.0' },
      verifier,
      'en',
    );

    const poiPark = result.mediaCatalog.pois['poi-park'];
    expect(poiPark).toBeDefined();
    expect(poiPark!.audio).toEqual({});
    expect(poiPark!.narratives['en']).toBe('poi-park:en');
  });

  it('rejects with hash-mismatch when audio is tampered', async () => {
    const { bundleId, version, packRoot } = await setupPack(tmpDir, privateKey);

    // Tamper with the audio file after signing.
    await fs.writeFile(
      path.join(packRoot, 'audio/poi-palace.en.m4a'),
      Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x00]),
    );

    await expect(loadPackTour(storage, { bundleId, version }, verifier, 'pl')).rejects.toThrow(
      PackIntegrityError,
    );
    await expect(
      loadPackTour(storage, { bundleId, version }, verifier, 'pl'),
    ).rejects.toMatchObject({ kind: 'hash-mismatch' });
  });

  it('rejects with asset-missing when audio file is deleted', async () => {
    const { bundleId, version, packRoot } = await setupPack(tmpDir, privateKey);

    // Remove the PL audio file.
    await fs.rm(path.join(packRoot, 'audio/poi-palace.pl.m4a'));

    await expect(loadPackTour(storage, { bundleId, version }, verifier, 'pl')).rejects.toThrow(
      PackIntegrityError,
    );
    await expect(
      loadPackTour(storage, { bundleId, version }, verifier, 'pl'),
    ).rejects.toMatchObject({ kind: 'asset-missing' });
  });

  it('rejects with asset-not-listed when audio is not in lock', async () => {
    const { bundleId, version, packRoot, allAssets } = await setupPack(tmpDir, privateKey);

    // Create a new audio file that is NOT in the lock.
    const extraAudioPath = path.join(packRoot, 'audio/poi-palace.de.m4a');
    await fs.writeFile(extraAudioPath, Buffer.from([0x00, 0x01]));

    // Update pois.json to reference the unlisted de audio.
    const poisContent = JSON.stringify({
      pois: [
        {
          id: 'poi-palace',
          priority: 90,
          geometry: { kind: 'circle', center: [51.0, 17.0], radiusMeters: 50 },
          dwellSec: 3,
          narratives: {
            en: 'narratives/en/poi-palace.md',
            pl: 'narratives/pl/poi-palace.md',
          },
          audio: {
            en: 'audio/poi-palace.en.m4a',
            pl: 'audio/poi-palace.pl.m4a',
            de: 'audio/poi-palace.de.m4a', // Not in lock!
          },
          tone: 'standard',
        },
        {
          id: 'poi-park',
          priority: 80,
          geometry: {
            kind: 'circle',
            center: [51.05, 17.05],
            radiusMeters: 40,
          },
          dwellSec: 3,
          narratives: { en: 'narratives/en/poi-park.md' },
          tone: 'standard',
        },
      ],
    });

    // Rebuild pois.json and re-sign.
    const poisBuf = Buffer.from(poisContent);
    const poisSha = crypto.createHash('sha256').update(poisBuf).digest('hex');
    await fs.writeFile(path.join(packRoot, 'pois.json'), poisBuf);

    // Rebuild the lock with updated pois.json hash but without the de audio.
    const updatedAssets = allAssets.map((a) =>
      a.asset.path === 'pois.json'
        ? {
            ...a,
            asset: {
              ...a.asset,
              sizeBytes: poisBuf.length,
              sha256: poisSha,
            },
          }
        : a,
    );
    const signed = buildSignedManifest(
      privateKey,
      bundleId,
      version,
      updatedAssets.map((a) => a.asset),
    );
    await fs.writeFile(path.join(packRoot, SIGNED_LOCK_RELATIVE_PATH), JSON.stringify(signed));

    await expect(loadPackTour(storage, { bundleId, version }, verifier, 'pl')).rejects.toThrow(
      PackIntegrityError,
    );
    await expect(
      loadPackTour(storage, { bundleId, version }, verifier, 'pl'),
    ).rejects.toMatchObject({ kind: 'asset-not-listed' });
  });

  it('rejects when one language is tampered even if another is valid', async () => {
    const { bundleId, version, packRoot } = await setupPack(tmpDir, privateKey);

    // Tamper ONLY the English audio — Polish remains valid.
    await fs.writeFile(
      path.join(packRoot, 'audio/poi-palace.en.m4a'),
      Buffer.from([0xba, 0xad, 0xf0, 0x0d, 0x00, 0x00, 0x00, 0x00]),
    );

    // Should reject the entire pack — cannot partially load.
    await expect(loadPackTour(storage, { bundleId, version }, verifier, 'pl')).rejects.toThrow(
      PackIntegrityError,
    );
    await expect(
      loadPackTour(storage, { bundleId, version }, verifier, 'pl'),
    ).rejects.toMatchObject({
      kind: 'hash-mismatch',
      relativePath: 'audio/poi-palace.en.m4a',
    });
  });

  it('mediaCatalog is passed through to config.mediaCatalog', async () => {
    await setupPack(tmpDir, privateKey);
    const result = await loadPackTour(
      storage,
      { bundleId: 'test-audio-pack', version: '1.0.0' },
      verifier,
      'pl',
    );

    expect(result.config.mediaCatalog).toBeDefined();
    expect(result.config.mediaCatalog).toBe(result.mediaCatalog);
  });

  it('defaultLanguage in catalog matches manifest', async () => {
    await setupPack(tmpDir, privateKey);
    const result = await loadPackTour(
      storage,
      { bundleId: 'test-audio-pack', version: '1.0.0' },
      verifier,
      'pl',
    );

    expect(result.mediaCatalog.defaultLanguage).toBe('en');
  });
});
