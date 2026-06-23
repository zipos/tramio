// Offline_Pack downloader.
//
// design.md "## Offline Pack Format and Download Strategy" specifies a
// resumable, streaming, signature-gated download flow:
//
//   1. Catalog returns the lock file and `MANIFEST.lock.sig`.
//      Storage_Manager creates `${docs}/packs/{bundleId}/{version}.staging/`.
//   2. Crypto_Service verifies the signature against the embedded catalog
//      public-key set. If verification fails, the staging directory is
//      deleted and the pack is marked unstartable.
//   3. Assets download in dependency order: manifest -> route -> POIs ->
//      narratives -> audio -> tiles. Each file is streamed to a `.part`
//      file and atomically renamed only after the full SHA-256 matches
//      the lock.
//   4. State table `pack_progress` is updated as assets complete.
//   5. On resume, the loader reads the table and skips any `complete`
//      asset whose on-disk SHA-256 still matches.
//   6. When all assets are `complete`, the staging directory is renamed
//      to `${version}/` (atomic).
//
// This file implements steps 1–6. Steps 7–9 (re-verify on tour start,
// License_Token gating for protected asset decrypt) layer on top in
// later tasks via Crypto_Service.
//
// Validates: Requirements 3.1, 3.3, 3.4, 3.5

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { KeyObject } from 'node:crypto';

import type { PackRef } from './paths';
import type { StorageManager } from './manager';
import type { PackProgressStatus } from './schema';
import { stageAndRename } from './fs';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/**
 * Encryption metadata for a protected asset. Storage_Manager treats
 * the on-disk bytes as opaque ciphertext and only verifies `sha256`
 * over the on-disk bytes; `plaintextSha256` is consumed later by
 * Crypto_Service after decryption.
 */
export interface ManifestLockAssetEncryption {
  readonly scheme: 'aes-256-gcm-framed-v1';
  readonly chunkSize?: number;
  readonly plaintextSha256?: string;
}

/** A single entry in `MANIFEST.lock.json#assets`. */
export interface ManifestLockAsset {
  /** Pack-relative path, e.g. `manifest.json`, `tiles/12/2240/1389.pbf`. */
  readonly path: string;
  /** Total size of the on-disk bytes. */
  readonly sizeBytes: number;
  /** Lower-hex SHA-256 of the on-disk bytes. */
  readonly sha256: string;
  readonly protected?: boolean;
  readonly encryption?: ManifestLockAssetEncryption;
}

/** The signed payload of `MANIFEST.lock.json`. */
export interface ManifestLockPayload {
  readonly bundleId: string;
  readonly version: string;
  readonly assets: ReadonlyArray<ManifestLockAsset>;
  readonly createdAt: string;
}

/**
 * Signed envelope for `MANIFEST.lock.json`. The `signature` field is the
 * Ed25519 signature over the canonical JSON encoding of `payload`,
 * base64url-encoded. The wire shape matches the backend's `SignedEnvelope`.
 */
export interface SignedManifest {
  readonly payload: ManifestLockPayload;
  readonly signature: string;
  readonly kid: string;
}

// ---------------------------------------------------------------------------
// HTTP fetch abstraction
// ---------------------------------------------------------------------------

/**
 * HTTP fetch surface used by the downloader. Production wiring (task 6.2)
 * supplies the chokepoint client that blocks outbound requests during an
 * active tour; tests inject a fake that serves bytes from memory.
 */
export interface PackHttpClient {
  /**
   * Fetch the signed `MANIFEST.lock.json` envelope for `bundleId@version`.
   *
   * Implementations MUST surface the wire envelope unmodified so the
   * downloader can verify the signature itself.
   */
  fetchManifest(ref: PackRef): Promise<SignedManifest>;

  /**
   * Stream `assetPath` for `bundleId@version`. Implementations return an
   * async iterable that yields raw bytes in order. The downloader hashes
   * and writes chunks as they arrive, so the implementation MUST NOT
   * buffer the whole asset — that would defeat streaming verification on
   * large media files.
   *
   * Implementations MAY throw mid-iteration to simulate a network
   * interruption; the downloader will leave the corresponding row in
   * `pack_progress` at `partial` so a subsequent call resumes cleanly.
   */
  fetchAsset(ref: PackRef, assetPath: string): Promise<AsyncIterable<Uint8Array>>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type DownloadErrorKind =
  | 'manifest-fetch'
  | 'signature'
  | 'sha-mismatch'
  | 'http'
  | 'io';

export interface DownloadError {
  readonly assetPath: string;
  readonly kind: DownloadErrorKind;
  readonly message: string;
}

/** Outcome of `OfflinePackDownloader.download`. */
export type DownloadResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * Number of assets that are still not `complete` after this call.
       * Mirrors the "missing-asset count" surfaced by the route selection
       * screen for partially downloaded packs (Req 3.5).
       */
      readonly missingCount: number;
      readonly errors: ReadonlyArray<DownloadError>;
    };

// ---------------------------------------------------------------------------
// Downloader options
// ---------------------------------------------------------------------------

export interface OfflinePackDownloaderOptions {
  readonly storage: StorageManager;
  readonly http: PackHttpClient;
  /**
   * Ed25519 public key used to verify `MANIFEST.lock.json#signature`.
   * Production wiring pins this key from the catalog public-key set
   * shipped in the app binary; tests generate a fresh keypair and pass
   * the public half here.
   */
  readonly verificationKey: KeyObject;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Download an Offline_Pack with streaming SHA-256 verification, atomic
 * stage+rename, and resumability backed by the `pack_progress` table.
 *
 * Compose this on top of `StorageManager` rather than extending it: the
 * downloader is one of several consumers of the manager (LRU evictor,
 * license cache, etc.), and keeping the surfaces separate means each can
 * evolve independently.
 */
export class OfflinePackDownloader {
  private readonly storage: StorageManager;
  private readonly http: PackHttpClient;
  private readonly verificationKey: KeyObject;

  constructor(opts: OfflinePackDownloaderOptions) {
    this.storage = opts.storage;
    this.http = opts.http;
    this.verificationKey = opts.verificationKey;
  }

  /**
   * Download (or resume) the pack identified by `bundleId@version`.
   *
   * Returns `{ ok: true }` once every asset is verified and the staging
   * directory has been promoted to the final pack directory. On failure
   * returns `{ ok: false, missingCount, errors }` and leaves the staging
   * directory in place so a subsequent call can resume.
   */
  async download(bundleId: string, version: string): Promise<DownloadResult> {
    const ref: PackRef = { bundleId, version };

    // Step 1: fetch the signed manifest envelope.
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

    // Step 2: verify the detached signature against the embedded public key.
    if (!verifyManifestSignature(this.verificationKey, signed)) {
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

    // Sanity-check that the manifest matches the requested ref. The signed
    // envelope is bound to the bundle/version, so a server returning
    // someone else's manifest would otherwise silently overwrite the
    // wrong staging dir.
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

    // Step 3: prepare the staging directory and seed pack_progress.
    const stagingRoot = this.storage.stagingDir(ref);
    await fs.mkdir(stagingRoot, { recursive: true });
    await this.seedPackProgress(ref, ordered);

    // Step 4: download each asset in dependency order.
    const errors: DownloadError[] = [];
    for (const asset of ordered) {
      const finalPath = path.join(stagingRoot, asset.path);
      const partPath = `${finalPath}.part`;

      // Resume: if on-disk bytes already match the lock file's SHA, mark
      // complete and skip. This covers the case where pack_progress is
      // missing or out of sync with the filesystem.
      // eslint-disable-next-line no-await-in-loop
      const onDiskMatches = await this.storage.verifySha256(finalPath, asset.sha256);
      if (onDiskMatches) {
        // eslint-disable-next-line no-await-in-loop
        await this.upsertProgress(ref, asset, 'complete', asset.sizeBytes);
        continue;
      }

      // Mark as partial before the network call so a crash mid-stream
      // leaves the row in the right state for the resume path.
      // eslint-disable-next-line no-await-in-loop
      await this.upsertProgress(ref, asset, 'partial', 0);

      try {
        // eslint-disable-next-line no-await-in-loop
        const bytesWritten = await this.streamAssetToPartFile(ref, asset, partPath);

        // Streaming verifier already checked the SHA. Promote the .part
        // file into place with the atomic rename helper.
        // eslint-disable-next-line no-await-in-loop
        await stageAndRename(partPath, finalPath);
        // eslint-disable-next-line no-await-in-loop
        await this.upsertProgress(ref, asset, 'complete', bytesWritten);
      } catch (err) {
        // Best-effort cleanup of the partial file. The row stays at
        // `partial` so the next call re-downloads from scratch.
        // eslint-disable-next-line no-await-in-loop
        await fs.rm(partPath, { force: true }).catch(() => undefined);
        errors.push({
          assetPath: asset.path,
          kind: classifyError(err),
          message: errorMessage(err),
        });
      }
    }

    // Step 5: refuse to promote the pack until every asset is complete.
    if (errors.length > 0) {
      const missingCount = await this.countMissing(ref);
      return { ok: false, missingCount, errors };
    }

    const missingAfter = await this.countMissing(ref);
    if (missingAfter > 0) {
      // Belt and braces: should never happen if the loop reported no
      // errors, but keep the invariant explicit so a future regression
      // does not silently promote an incomplete pack.
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

    // Step 6: promote the staging directory to the final pack directory.
    const finalPackDir = this.storage.packDir(ref);
    await stageAndRename(stagingRoot, finalPackDir);

    return { ok: true };
  }

  /**
   * True iff every asset for `bundleId@version` has `pack_progress.status
   * = 'complete'` AND the staging directory has been promoted to the
   * final pack directory.
   *
   * Validates: Requirement 3.5.
   */
  async isPackStartable(bundleId: string, version: string): Promise<boolean> {
    const ref: PackRef = { bundleId, version };

    // The final pack dir must exist (i.e., staging has been promoted).
    const finalDir = this.storage.packDir(ref);
    try {
      const stat = await fs.stat(finalDir);
      if (!stat.isDirectory()) {
        return false;
      }
    } catch {
      return false;
    }

    // There must be at least one row, and every row must be complete.
    const rows = await this.storage.driver.all<{ status: string }>(
      `SELECT status FROM pack_progress WHERE bundle_id = ? AND version = ?`,
      [bundleId, version],
    );
    if (rows.length === 0) {
      return false;
    }
    return rows.every((r) => r.status === 'complete');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async seedPackProgress(
    ref: PackRef,
    assets: ReadonlyArray<ManifestLockAsset>,
  ): Promise<void> {
    // Insert any rows that don't yet exist as `pending`. Existing rows
    // (from an earlier attempt) keep their current status so the resume
    // logic can short-circuit completed assets.
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
      [
        ref.bundleId,
        ref.version,
        asset.path,
        status,
        asset.sizeBytes,
        bytesDone,
        sha,
        Date.now(),
      ],
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

  /**
   * Stream the asset to a `.part` file, computing the SHA-256
   * incrementally as bytes flow in. Returns the number of bytes written.
   * Throws on SHA mismatch or any I/O error so the caller can record a
   * `DownloadError` and leave the row at `partial`.
   */
  private async streamAssetToPartFile(
    ref: PackRef,
    asset: ManifestLockAsset,
    partPath: string,
  ): Promise<number> {
    await fs.mkdir(path.dirname(partPath), { recursive: true });

    const stream = await this.http.fetchAsset(ref, asset.path);
    const hash = crypto.createHash('sha256');
    let bytesWritten = 0;

    // Truncate any leftover .part bytes from a prior interrupted run.
    const handle = await fs.open(partPath, 'w');
    try {
      for await (const chunk of stream) {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
        hash.update(buf);
        await handle.write(buf);
        bytesWritten += buf.length;
      }
    } finally {
      await handle.close();
    }

    const actualHex = hash.digest('hex');
    const expectedHex = asset.sha256.toLowerCase();
    if (actualHex !== expectedHex) {
      throw new ShaMismatchError(asset.path, expectedHex, actualHex);
    }

    // Sanity-check size against the lock file. The streaming verifier
    // already covers content; this catches a manifest with an inflated
    // size header masking a truncated download — though in practice the
    // SHA check would catch it first.
    if (bytesWritten !== asset.sizeBytes) {
      throw new ShaMismatchError(
        asset.path,
        `${asset.sizeBytes} bytes`,
        `${bytesWritten} bytes`,
      );
    }

    return bytesWritten;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Order assets by the dependency rule from design.md:
 *   manifest.json -> route.json -> pois.json -> narratives -> audio -> tiles.
 *
 * Anything we don't recognize sorts after `tiles` so the downloader still
 * makes progress on a future asset class without code changes here.
 *
 * The sort is stable on `path` to keep output deterministic for tests.
 */
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
 * Verify the Ed25519 signature on a `SignedManifest`.
 *
 * The byte string covered by the signature is the canonical JSON encoding
 * of `payload` (sorted object keys, no whitespace) — same algorithm used
 * by the backend's `signing.ts`. The signature is base64url-encoded.
 */
export function verifyManifestSignature(
  publicKey: KeyObject,
  signed: SignedManifest,
): boolean {
  let ok = false;
  try {
    const canonical = canonicalJsonStringify(signed.payload);
    const sig = base64urlDecode(signed.signature);
    ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, sig);
  } catch {
    ok = false;
  }
  return ok;
}

/**
 * Deterministic JSON serialization with sorted object keys. Matches the
 * algorithm in `packages/backend/src/signing.ts#canonicalJsonStringify`
 * so signatures produced by the backend verify here without modification.
 *
 * Duplicated rather than imported so this package stays free of a
 * runtime dependency on the backend.
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
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * Base64url decode (no padding required, RFC 7515). Mirror of the helper
 * in the backend's `signing.ts` so we can verify envelopes signed there.
 */
function base64urlDecode(s: string): Buffer {
  const padLen = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
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
