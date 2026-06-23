// SQLite schema for Storage_Manager.
//
// Tables here mirror the responsibilities listed in design.md
// "### Storage_Manager":
//
//   - pack_progress       — per-asset download status (Req 3.3, 3.4, 3.5)
//   - entitlement_cache   — signed entitlement payload + expiry (Req 13.2, 13.3)
//   - lru_access          — per-pack last-access timestamp + bytes used (Req 19.3, 19.5)
//   - moderation_snapshot — Catalog_Service moderation state (Req 20.3)
//   - device_id           — single-row Device_Id table (Req 13.1)
//   - license_tokens      — License_Token cache (design.md "License_Token format and lifecycle")
//
// All tables use `IF NOT EXISTS` so the migration runner is safely
// idempotent. A `_schema_version` table records the highest applied
// version so future schema changes can be layered on without a wipe.

/**
 * `pack_progress.status` enum, narrowed in TS for downstream consumers.
 * Stored as TEXT in SQLite; CHECK constraint enforces the set.
 */
export type PackProgressStatus = 'pending' | 'partial' | 'complete';

export interface PackProgressRow {
  bundle_id: string;
  version: string;
  asset_path: string;
  status: PackProgressStatus;
  bytes_total: number;
  bytes_done: number;
  /** Lower-hex SHA-256 (64 chars) once the asset has been verified, else null. */
  sha256: string | null;
  /** Wall-clock ms (UTC). */
  updated_at: number;
}

export interface EntitlementCacheRow {
  device_id: string;
  payload_jws: string;
  /** UTC seconds since the epoch. */
  expiry_utc: number;
  fetched_at_utc: number;
}

export interface LruAccessRow {
  bundle_id: string;
  version: string;
  last_access_utc: number;
  bytes_used: number;
}

export interface ModerationSnapshotRow {
  snapshot_id: string;
  fetched_at_utc: number;
  payload_json: string;
}

export interface DeviceIdRow {
  /** Always 1; this is a single-row table. */
  id: number;
  device_id: string;
  created_at_utc: number;
}

export interface LicenseTokenRow {
  bundle_id: string;
  bundle_version: string;
  /** JWS compact serialization stored as BLOB. */
  jws: Uint8Array;
  exp_utc: number;
  fetched_at_utc: number;
}

/**
 * The DDL for the schema, as a single SQL blob. Each statement is
 * idempotent (`IF NOT EXISTS`). The migration runner executes this
 * inside a transaction.
 *
 * Notes on column types:
 *  - SQLite has no boolean or enum types. We emulate enums via TEXT +
 *    CHECK constraints. Timestamps are INTEGER millis or seconds as
 *    documented per row type.
 *  - `device_id` is a single-row table with a CHECK pinning `id = 1`.
 *  - `license_tokens` matches the design.md DDL verbatim, with `jws`
 *    typed BLOB.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pack_progress (
  bundle_id   TEXT NOT NULL,
  version     TEXT NOT NULL,
  asset_path  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','partial','complete')),
  bytes_total INTEGER NOT NULL CHECK (bytes_total >= 0),
  bytes_done  INTEGER NOT NULL CHECK (bytes_done  >= 0),
  sha256      TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (bundle_id, version, asset_path)
);

CREATE INDEX IF NOT EXISTS idx_pack_progress_status
  ON pack_progress (bundle_id, version, status);

CREATE TABLE IF NOT EXISTS entitlement_cache (
  device_id      TEXT NOT NULL PRIMARY KEY,
  payload_jws    TEXT NOT NULL,
  expiry_utc     INTEGER NOT NULL,
  fetched_at_utc INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lru_access (
  bundle_id       TEXT NOT NULL,
  version         TEXT NOT NULL,
  last_access_utc INTEGER NOT NULL,
  bytes_used      INTEGER NOT NULL CHECK (bytes_used >= 0),
  PRIMARY KEY (bundle_id, version)
);

CREATE INDEX IF NOT EXISTS idx_lru_access_last
  ON lru_access (last_access_utc);

CREATE TABLE IF NOT EXISTS moderation_snapshot (
  snapshot_id    TEXT NOT NULL PRIMARY KEY,
  fetched_at_utc INTEGER NOT NULL,
  payload_json   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_id (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  device_id      TEXT NOT NULL,
  created_at_utc INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS license_tokens (
  bundle_id      TEXT NOT NULL,
  bundle_version TEXT NOT NULL,
  jws            BLOB NOT NULL,
  exp_utc        INTEGER NOT NULL,
  fetched_at_utc INTEGER NOT NULL,
  PRIMARY KEY (bundle_id, bundle_version)
);
`;

/**
 * Schema version installed by `SCHEMA_SQL`. Bump when the DDL changes.
 * The migration runner records this in `_schema_version` so future
 * migrations can layer on conditionally.
 */
export const SCHEMA_VERSION = 1;
