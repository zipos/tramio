// Offline_Pack downloader core — no Node built-ins (React Native safe).
//
// @see downloader.ts for the Node test harness and verifyManifestSignature.

import type { PackRef } from './paths';
import type { StorageManager } from './manager';
import type { PackProgressStatus } from './schema';
import { stageAndRename } from './fsPort';
import { assertSafePackRelativePath, pathDirname, pathJoin } from './pathJoin';

import type {
  DownloadError,
  DownloadErrorKind,
  DownloadResult,
  ManifestLockAsset,
  ManifestVerifier,
  OfflinePackDownloaderOptions,
  PackHttpClient,
  SignedManifest,
} from './downloader-types';

export type {
  DownloadError,
  DownloadErrorKind,
  DownloadResult,
  ManifestLockAsset,
  ManifestLockAssetEncryption,
  ManifestLockPayload,
  ManifestVerifier,
  OfflinePackDownloaderOptions,
  PackHttpClient,
  SignedManifest,
} from './downloader-types';

/**
 * Download an Offline_Pack with streaming SHA-256 verification, atomic
 * stage+rename, and resumability backed by the `pack_progress` table.
 */
export class OfflinePackDownloader {
  private readonly storage: StorageManager;
  private readonly http: PackHttpClient;
  private readonly manifestVerifier: ManifestVerifier;

  constructor(opts: OfflinePackDownloaderOptions) {
    this.storage = opts.storage;
    this.http = opts.http;
    this.manifestVerifier = opts.manifestVerifier;
  }

  async download(bundleId: string, version: string): Promise<DownloadResult> {
    const ref: PackRef = { bundleId, version };

    let signed: SignedManifest;
    try {
      signed = await this.http.fetchManifest(ref);
    } catch (err) {
      return {
        ok: false,
        missingCount: -1,
        errors: [
          {
            assetPath: 'MANIFEST.lock.json',
            kind: 'manifest-fetch',
            message: errorMessage(err),
          },
        ],
      };
    }

    const signatureOk = await this.manifestVerifier.verify(signed);
    if (!signatureOk) {
      return {
        ok: false,
        missingCount: signed.payload.assets.length,
        errors: [
          {
            assetPath: 'MANIFEST.lock.json',
            kind: 'signature',
            message: 'manifest signature did not verify against verification key',
          },
        ],
      };
    }

    if (signed.payload.bundleId !== bundleId || signed.payload.version !== version) {
      return {
        ok: false,
        missingCount: signed.payload.assets.length,
        errors: [
          {
            assetPath: 'MANIFEST.lock.json',
            kind: 'manifest-fetch',
            message: `manifest ref mismatch: expected ${bundleId}@${version}, got ${signed.payload.bundleId}@${signed.payload.version}`,
          },
        ],
      };
    }

    const manifest = signed.payload;
    const ordered = sortByDependencyOrder(manifest.assets);

    const stagingRoot = this.storage.stagingDir(ref);
    await this.storage.fs.mkdir(stagingRoot, { recursive: true });
    await this.seedPackProgress(ref, ordered);

    const errors: DownloadError[] = [];
    for (const asset of ordered) {
      try {
        assertSafePackRelativePath(asset.path);
      } catch (err) {
        errors.push({
          assetPath: asset.path,
          kind: 'io',
          message: errorMessage(err),
        });
        continue;
      }

      const finalPath = pathJoin(stagingRoot, asset.path);
      const partPath = `${finalPath}.part`;

      // eslint-disable-next-line no-await-in-loop
      const onDiskMatches = await this.storage.verifySha256(finalPath, asset.sha256);
      if (onDiskMatches) {
        // eslint-disable-next-line no-await-in-loop
        await this.upsertProgress(ref, asset, 'complete', asset.sizeBytes);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await this.upsertProgress(ref, asset, 'partial', 0);

      try {
        // eslint-disable-next-line no-await-in-loop
        const bytesWritten = await this.streamAssetToPartFile(ref, asset, partPath);
        // eslint-disable-next-line no-await-in-loop
        await stageAndRename(this.storage.fs, partPath, finalPath);
        // eslint-disable-next-line no-await-in-loop
        await this.upsertProgress(ref, asset, 'complete', bytesWritten);
      } catch (err) {
        // eslint-disable-next-line no-await-in-loop
        await this.storage.fs.rm(partPath, { force: true }).catch(() => undefined);
        errors.push({
          assetPath: asset.path,
          kind: classifyError(err),
          message: errorMessage(err),
        });
      }
    }

    if (errors.length > 0) {
      const missingCount = await this.countMissing(ref);
      return { ok: false, missingCount, errors };
    }

    const missingAfter = await this.countMissing(ref);
    if (missingAfter > 0) {
      return {
        ok: false,
        missingCount: missingAfter,
        errors: [
          {
            assetPath: 'pack_progress',
            kind: 'io',
            message: `expected all assets complete, ${missingAfter} still missing`,
          },
        ],
      };
    }

    const finalPackDir = this.storage.packDir(ref);
    await stageAndRename(this.storage.fs, stagingRoot, finalPackDir);

    return { ok: true };
  }

  async isPackStartable(bundleId: string, version: string): Promise<boolean> {
    const ref: PackRef = { bundleId, version };

    const finalDir = this.storage.packDir(ref);
    try {
      const stat = await this.storage.fs.stat(finalDir);
      if (stat === null || !stat.isDirectory) {
        return false;
      }
    } catch {
      return false;
    }

    const rows = await this.storage.driver.all<{ status: string }>(
      `SELECT status FROM pack_progress WHERE bundle_id = ? AND version = ?`,
      [bundleId, version],
    );
    if (rows.length === 0) {
      return false;
    }
    return rows.every((r) => r.status === 'complete');
  }

  private async seedPackProgress(
    ref: PackRef,
    assets: ReadonlyArray<ManifestLockAsset>,
  ): Promise<void> {
    for (const asset of assets) {
      // eslint-disable-next-line no-await-in-loop
      await this.storage.driver.run(
        `INSERT INTO pack_progress
           (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
         VALUES (?, ?, ?, 'pending', ?, 0, NULL, ?)
         ON CONFLICT(bundle_id, version, asset_path) DO UPDATE SET
           bytes_total = excluded.bytes_total,
           updated_at  = excluded.updated_at`,
        [ref.bundleId, ref.version, asset.path, asset.sizeBytes, Date.now()],
      );
    }
  }

  private async upsertProgress(
    ref: PackRef,
    asset: ManifestLockAsset,
    status: PackProgressStatus,
    bytesDone: number,
  ): Promise<void> {
    const sha = status === 'complete' ? asset.sha256.toLowerCase() : null;
    await this.storage.driver.run(
      `INSERT INTO pack_progress
         (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bundle_id, version, asset_path) DO UPDATE SET
         status      = excluded.status,
         bytes_total = excluded.bytes_total,
         bytes_done  = excluded.bytes_done,
         sha256      = excluded.sha256,
         updated_at  = excluded.updated_at`,
      [ref.bundleId, ref.version, asset.path, status, asset.sizeBytes, bytesDone, sha, Date.now()],
    );
  }

  private async countMissing(ref: PackRef): Promise<number> {
    const row = await this.storage.driver.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM pack_progress
        WHERE bundle_id = ? AND version = ? AND status <> 'complete'`,
      [ref.bundleId, ref.version],
    );
    return row?.n ?? 0;
  }

  private async streamAssetToPartFile(
    ref: PackRef,
    asset: ManifestLockAsset,
    partPath: string,
  ): Promise<number> {
    await this.storage.fs.mkdir(pathDirname(partPath), { recursive: true });

    const stream = await this.http.fetchAsset(ref, asset.path);
    const { bytesWritten, sha256Hex: actualHex } = await this.storage.fs.writeFromIterable(
      partPath,
      stream as AsyncIterable<Uint8Array>,
    );
    const expectedHex = asset.sha256.toLowerCase();
    if (actualHex !== expectedHex) {
      throw new ShaMismatchError(asset.path, expectedHex, actualHex);
    }

    if (bytesWritten !== asset.sizeBytes) {
      throw new ShaMismatchError(asset.path, `${asset.sizeBytes} bytes`, `${bytesWritten} bytes`);
    }

    return bytesWritten;
  }
}

export function sortByDependencyOrder(
  assets: ReadonlyArray<ManifestLockAsset>,
): ReadonlyArray<ManifestLockAsset> {
  const indexed = assets.map((asset, idx) => ({
    asset,
    rank: dependencyRank(asset.path),
    idx,
  }));
  indexed.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.asset.path < b.asset.path ? -1 : a.asset.path > b.asset.path ? 1 : a.idx - b.idx;
  });
  return indexed.map((e) => e.asset);
}

function dependencyRank(assetPath: string): number {
  if (assetPath === 'manifest.json') return 0;
  if (assetPath === 'route.json') return 1;
  if (assetPath === 'pois.json') return 2;
  if (assetPath.startsWith('narratives/')) return 3;
  if (assetPath.startsWith('audio/')) return 4;
  if (assetPath.startsWith('tiles/')) return 5;
  return 6;
}

export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

class ShaMismatchError extends Error {
  public override readonly name = 'ShaMismatchError';
  public readonly assetPath: string;
  public readonly expected: string;
  public readonly actual: string;
  constructor(assetPath: string, expected: string, actual: string) {
    super(`SHA-256 mismatch for ${assetPath}: expected ${expected}, got ${actual}`);
    this.assetPath = assetPath;
    this.expected = expected;
    this.actual = actual;
  }
}

function classifyError(err: unknown): DownloadErrorKind {
  if (err instanceof ShaMismatchError) return 'sha-mismatch';
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string' &&
    String((err as { code: string }).code).startsWith('E')
  ) {
    return 'io';
  }
  return 'http';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
