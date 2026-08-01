// Offline_Pack downloader core — no Node built-ins (React Native safe).
//
// @see downloader.ts for the Node test harness and verifyManifestSignature.

import type { PackRef } from './paths';
import type { StorageManager } from './manager';
import type { PackProgressStatus } from './schema';
import { stageAndRename } from './fsPort';
import { assertSafePackRelativePath, pathDirname, pathJoin } from './pathJoin';
import { CONTROL_DIR, SIGNED_LOCK_RELATIVE_PATH } from './controlFile';
import { KeyedMutex } from './keyedMutex';

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
  private readonly downloadMutex = new KeyedMutex();

  constructor(opts: OfflinePackDownloaderOptions) {
    this.storage = opts.storage;
    this.http = opts.http;
    this.manifestVerifier = opts.manifestVerifier;
  }

  /**
   * Download a pack. Same bundle@version calls serialize via keyed mutex;
   * different refs proceed concurrently.
   */
  async download(bundleId: string, version: string): Promise<DownloadResult> {
    const key = `${bundleId}@${version}`;
    return this.downloadMutex.withLock(key, () => this.downloadInternal(bundleId, version));
  }

  private async downloadInternal(bundleId: string, version: string): Promise<DownloadResult> {
    const ref: PackRef = { bundleId, version };

    // Run recovery at entry — ensures consistent starting state.
    await this.recover(bundleId, version);

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

    // Persist the signed envelope as the control file BEFORE activation.
    // This is the trust anchor for all subsequent load-time verification.
    const controlDir = pathJoin(stagingRoot, CONTROL_DIR);
    await this.storage.fs.mkdir(controlDir, { recursive: true });
    const lockPath = pathJoin(stagingRoot, SIGNED_LOCK_RELATIVE_PATH);
    await this.storage.fs.writeUtf8(lockPath, JSON.stringify(signed));

    // --- Crash-safe activation (backup-then-swap) ---
    const finalPackDir = this.storage.packDir(ref);
    const backupDir = `${finalPackDir}.backup`;

    // If a previous backup exists (abandoned recovery), remove it first.
    await this.storage.fs.rm(backupDir, { recursive: true, force: true });

    // If the final directory already exists (reinstall same version),
    // move it to backup before promoting staging.
    const finalStat = await this.storage.fs.stat(finalPackDir);
    if (finalStat !== null && finalStat.isDirectory) {
      await this.storage.fs.rename(finalPackDir, backupDir);
    }

    // Promote staging to final (atomic rename on same volume).
    try {
      await stageAndRename(this.storage.fs, stagingRoot, finalPackDir);
    } catch (promoteErr) {
      // Rollback: restore backup if promotion failed.
      const backupExists = await this.storage.fs.stat(backupDir);
      if (backupExists !== null && backupExists.isDirectory) {
        await this.storage.fs.rename(backupDir, finalPackDir).catch(() => undefined);
      }
      throw promoteErr;
    }

    // Promotion succeeded — remove the backup (best-effort).
    await this.storage.fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);

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

    // Verify signed lock control file exists.
    const lockPath = pathJoin(finalDir, SIGNED_LOCK_RELATIVE_PATH);
    const lockStat = await this.storage.fs.stat(lockPath);
    if (lockStat === null || !lockStat.isFile) {
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

  /**
   * Recover from crash/abandoned states on startup or before a new download.
   *
   * Redesigned recovery rules (Wave 2 fix):
   *
   * 1. **final + backup**: Final is the post-promotion candidate. Verify its
   *    signed envelope, identity, and every listed asset digest/size. If valid,
   *    remove stale backup. If final cannot verify, restore backup.
   *    Staging is KEPT for resume of an interrupted update.
   *
   * 2. **no final + backup**: Restore backup to final. KEEP staging — it is
   *    the resumable download for the interrupted new version.
   *
   * 3. **staging without backup (no final)**: KEEP staging for resume.
   *    Never promote and never delete merely because it exists.
   *
   * 4. **final + staging without backup**: KEEP staging — it is a resumable
   *    reinstall/update attempt. Only clean up if final is valid.
   *    (Staging is not deleted here; the next download() call will resume it.)
   *
   * Key invariant: staging is NEVER deleted by recovery. It stores verified
   * partial assets for Property 14 resume.
   */
  async recover(bundleId: string, version: string): Promise<void> {
    const ref: PackRef = { bundleId, version };
    const finalDir = this.storage.packDir(ref);
    const backupDir = `${finalDir}.backup`;

    const finalStat = await this.storage.fs.stat(finalDir);
    const backupStat = await this.storage.fs.stat(backupDir);

    if (finalStat !== null && finalStat.isDirectory) {
      if (backupStat !== null && backupStat.isDirectory) {
        // Case 1: final + backup. Verify the complete promoted pack before
        // discarding the only known-good rollback copy.
        const finalValid = await this.verifyFinalPack(ref);
        if (finalValid) {
          // Final is good — remove stale backup.
          await this.storage.fs.rm(backupDir, { recursive: true, force: true });
        } else {
          // Final is broken — restore backup.
          await this.storage.fs.rm(finalDir, { recursive: true, force: true });
          await this.storage.fs.rename(backupDir, finalDir);
        }
      }
      // Cases: final exists (with or without staging, no backup) — nothing to do.
      // Staging is kept for resume.
      return;
    }

    // Final absent.
    if (backupStat !== null && backupStat.isDirectory) {
      // Case 2: no final + backup — restore backup to final.
      await this.storage.fs.rename(backupDir, finalDir);
      // Staging is KEPT for resume of the interrupted new download.
      return;
    }

    // Case 3: no final, no backup — staging (if any) is kept for resume.
    // Nothing to do.
  }

  /**
   * Verify the complete final pack before recovery discards a known-good backup.
   * Signature+identity alone only prove the lock is authentic; every listed
   * asset must also still exist with the signed size and digest. This path is
   * rare (only a crash left both final and backup), so hashing the full pack is
   * preferable to preserving a corrupt promoted directory.
   */
  private async verifyFinalPack(ref: PackRef): Promise<boolean> {
    const finalDir = this.storage.packDir(ref);
    const lockPath = pathJoin(finalDir, SIGNED_LOCK_RELATIVE_PATH);

    try {
      const raw = await this.storage.fs.readUtf8(lockPath);
      const signed = JSON.parse(raw) as SignedManifest;

      const sigOk = await this.manifestVerifier.verify(signed);
      if (!sigOk) return false;
      if (signed.payload.bundleId !== ref.bundleId || signed.payload.version !== ref.version) {
        return false;
      }

      const results = await Promise.all(
        signed.payload.assets.map(async (asset) => {
          assertSafePackRelativePath(asset.path);
          const assetPath = pathJoin(finalDir, asset.path);
          const stat = await this.storage.fs.stat(assetPath);
          if (stat === null || !stat.isFile) return false;
          const size = await this.storage.fs.fileSize(assetPath);
          if (size !== null && size !== asset.sizeBytes) return false;
          return this.storage.verifySha256(assetPath, asset.sha256);
        }),
      );
      return results.every(Boolean);
    } catch {
      return false;
    }
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

/**
 * Deterministic JSON serialization with sorted object keys. Strings are
 * encoded by `JSON.stringify` so escaping rules match the standard parser.
 *
 * Keys whose value is `undefined` are skipped, matching `JSON.stringify`
 * semantics. This is critical because the server-side `canonicalJsonStringify`
 * in packages/backend/src/signing.ts MUST produce identical output — the two
 * implementations are kept in sync manually.
 *
 * @see packages/backend/src/signing.ts — server-side counterpart (keep in sync)
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    // Skip undefined-valued keys to match JSON.stringify semantics.
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(v));
  }
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
