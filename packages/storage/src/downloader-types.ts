// Wire types for the Offline_Pack downloader (React Native safe).

import type { PackRef } from './paths';
import type { StorageManager } from './manager';

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

export type DownloadErrorKind = 'manifest-fetch' | 'signature' | 'sha-mismatch' | 'http' | 'io';

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

export interface ManifestVerifier {
  verify(signed: SignedManifest): boolean | Promise<boolean>;
}

export interface OfflinePackDownloaderOptions {
  readonly storage: StorageManager;
  readonly http: PackHttpClient;
  /** Cross-platform verifier for React Native (noble + pinned SPKI). */
  readonly manifestVerifier: ManifestVerifier;
}
