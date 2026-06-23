/**
 * Wire types for the MVP backend API surface.
 *
 * Mirrors the table in design.md "Backend API Surface". Each JSON endpoint
 * returns a `SignedEnvelope<T>` whose `payload` is one of the types below.
 */

/** Catalog listing payload returned by `GET /v1/catalog`. */
export interface CatalogListPayload {
  readonly bundles: ReadonlyArray<CatalogBundleEntry>;
  readonly fetchedAt: string; // ISO-8601 UTC
}

export interface CatalogBundleEntry {
  readonly bundleId: string;
  readonly version: string;
  readonly sizeBytes: number;
  readonly requiredAppVersion: string;
}

/**
 * Lock file for a bundle/version, returned by
 * `GET /v1/catalog/{bundleId}/{version}/manifest.lock.json`.
 *
 * Matches the on-disk format described under "Offline Pack Format" in
 * design.md. We keep this loose (`Record<string, unknown>` for asset
 * entries) because the backend stub does not own the schema; the
 * authoring/storage packages do. The signing envelope covers the whole
 * payload as-is.
 */
export interface ManifestLockPayload {
  readonly bundleId: string;
  readonly version: string;
  readonly assets: ReadonlyArray<ManifestLockAsset>;
  readonly createdAt: string; // ISO-8601 UTC
}

export interface ManifestLockAsset {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string; // hex
  readonly encryption?: ManifestLockAssetEncryption;
}

export interface ManifestLockAssetEncryption {
  readonly scheme: 'aes-256-gcm-framed-v1';
  readonly chunkSize: number;
  readonly plaintextSha256: string;
}

/** `GET /v1/gtfs/{cityId}/latest`. */
export interface GtfsLatestPayload {
  readonly cityId: string;
  readonly feedVersion: string;
  readonly downloadUrl: string;
  readonly sha256: string; // hex
  readonly publishedAt: string; // ISO-8601 UTC
}

/** `GET /v1/entitlements`. */
export interface EntitlementsPayload {
  readonly deviceId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  readonly expiryUtc: string; // ISO-8601 UTC; cache-honoring deadline
}

/**
 * A single entitlement decision. Matches the engine's `Entitlement` type at
 * the level needed by the MVP backend — full type lives in `@tramio/engine`.
 */
export interface Entitlement {
  readonly tier: 'free' | 'time_pass' | 'token_unlock' | 'b2b';
  readonly bundleId?: string;
  readonly grantedAt: string; // ISO-8601 UTC
  readonly expiresAt?: string; // ISO-8601 UTC; absent for permanent grants
}

/** `POST /v1/entitlements/receipt`. */
export interface ReceiptRequest {
  readonly deviceId: string;
  readonly platformReceiptId: string;
  readonly platformReceipt: string;
}

export interface ReceiptResponsePayload {
  readonly deviceId: string;
  readonly platformReceiptId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  readonly expiryUtc: string;
}

/** `POST /v1/entitlements/restore`. */
export interface RestoreRequest {
  readonly deviceId: string;
  readonly receipts: ReadonlyArray<{
    readonly platformReceiptId: string;
    readonly platformReceipt: string;
  }>;
}

export interface RestoreResponsePayload {
  readonly deviceId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  readonly expiryUtc: string;
}

/** `GET /v1/moderation`. */
export interface ModerationPayload {
  readonly disabledSegmentIds: ReadonlyArray<string>;
  readonly fetchedAt: string; // ISO-8601 UTC
}
