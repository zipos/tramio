/**
 * In-memory catalog/entitlement/moderation store with optional filesystem
 * overlay for asset bytes.
 *
 * The MVP backend treats this as the single source of truth so unit tests
 * can construct stores in-process and integration tests (task 6.7) can
 * point a shared instance at a fixture directory under
 * `packages/backend/data/`.
 *
 * Production runs against the same code: a longer-lived process simply
 * pre-loads the same fixtures from disk at startup.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import type {
  CatalogBundleEntry,
  CatalogListPayload,
  Entitlement,
  GtfsLatestPayload,
  ManifestLockPayload,
  ModerationPayload,
} from './types';

/** A receipt the backend has already accepted. Used for idempotency. */
export interface RecordedReceipt {
  readonly deviceId: string;
  readonly platformReceiptId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  readonly expiryUtc: string;
}

export interface BackendStoreOptions {
  /**
   * Absolute path to a directory whose layout matches
   * `${assetRoot}/{bundleId}/{version}/{path}`. The asset endpoint streams
   * files from here. When omitted, the asset endpoint serves from the
   * in-memory `assets` map only.
   */
  readonly assetRoot?: string;
  readonly bundles?: ReadonlyArray<CatalogBundleEntry>;
  readonly manifests?: ReadonlyArray<ManifestLockPayload>;
  readonly assets?: ReadonlyArray<{
    readonly bundleId: string;
    readonly version: string;
    readonly path: string;
    readonly bytes: Buffer;
  }>;
  readonly gtfs?: ReadonlyArray<GtfsLatestPayload>;
  readonly entitlementsByDevice?: Record<string, ReadonlyArray<Entitlement>>;
  readonly defaultEntitlementExpiry?: string;
  readonly disabledSegmentIds?: ReadonlyArray<string>;
}

export interface AssetReadResult {
  readonly sizeBytes: number;
  readonly read: (start: number, end: number) => Promise<Buffer>;
}

export interface BackendStore {
  // Catalog
  listCatalog(): CatalogListPayload;
  getManifest(bundleId: string, version: string): ManifestLockPayload | undefined;
  readAsset(bundleId: string, version: string, path: string): Promise<AssetReadResult | undefined>;

  // GTFS
  getGtfsLatest(cityId: string): GtfsLatestPayload | undefined;

  // Entitlements
  resolveEntitlements(deviceId: string): {
    entitlements: ReadonlyArray<Entitlement>;
    expiryUtc: string;
  };
  recordReceipt(
    deviceId: string,
    platformReceiptId: string,
    grant: ReadonlyArray<Entitlement>,
  ): RecordedReceipt;
  restoreReceipts(
    deviceId: string,
    platformReceiptIds: ReadonlyArray<string>,
  ): { entitlements: ReadonlyArray<Entitlement>; expiryUtc: string };

  // Moderation
  getModeration(): ModerationPayload;
}

/** Create an in-memory store. */
export function createBackendStore(opts: BackendStoreOptions = {}): BackendStore {
  const bundles: CatalogBundleEntry[] = [...(opts.bundles ?? [])];
  const manifests = new Map<string, ManifestLockPayload>();
  for (const m of opts.manifests ?? []) {
    manifests.set(manifestKey(m.bundleId, m.version), m);
  }
  const memAssets = new Map<string, Buffer>();
  for (const a of opts.assets ?? []) {
    memAssets.set(assetKey(a.bundleId, a.version, a.path), a.bytes);
  }
  const gtfs = new Map<string, GtfsLatestPayload>();
  for (const g of opts.gtfs ?? []) {
    gtfs.set(g.cityId, g);
  }
  const entitlementsByDevice = new Map<string, ReadonlyArray<Entitlement>>();
  for (const [k, v] of Object.entries(opts.entitlementsByDevice ?? {})) {
    entitlementsByDevice.set(k, v);
  }
  const receipts = new Map<string, RecordedReceipt>(); // key = `${deviceId}::${platformReceiptId}`
  const disabled = new Set<string>(opts.disabledSegmentIds ?? []);
  const defaultExpiry =
    opts.defaultEntitlementExpiry ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return {
    listCatalog(): CatalogListPayload {
      return {
        bundles: [...bundles],
        fetchedAt: new Date().toISOString(),
      };
    },

    getManifest(bundleId, version) {
      return manifests.get(manifestKey(bundleId, version));
    },

    async readAsset(bundleId, version, path) {
      const memBytes = memAssets.get(assetKey(bundleId, version, path));
      if (memBytes !== undefined) {
        return makeMemoryReadResult(memBytes);
      }
      if (opts.assetRoot !== undefined) {
        const safePath = safeJoin(opts.assetRoot, bundleId, version, path);
        if (safePath === undefined) return undefined;
        try {
          const s = await stat(safePath);
          if (!s.isFile()) return undefined;
          return makeFileReadResult(safePath, s.size);
        } catch {
          return undefined;
        }
      }
      return undefined;
    },

    getGtfsLatest(cityId) {
      return gtfs.get(cityId);
    },

    resolveEntitlements(deviceId) {
      const grants = entitlementsByDevice.get(deviceId) ?? [];
      // Aggregate any receipt-derived entitlements for this device too.
      const fromReceipts: Entitlement[] = [];
      for (const r of receipts.values()) {
        if (r.deviceId === deviceId) fromReceipts.push(...r.entitlements);
      }
      return {
        entitlements: [...grants, ...fromReceipts],
        expiryUtc: defaultExpiry,
      };
    },

    recordReceipt(deviceId, platformReceiptId, grant) {
      const key = receiptKey(deviceId, platformReceiptId);
      const existing = receipts.get(key);
      if (existing !== undefined) {
        // Idempotent on `(deviceId, platformReceiptId)` per design.md.
        return existing;
      }
      const recorded: RecordedReceipt = {
        deviceId,
        platformReceiptId,
        entitlements: [...grant],
        expiryUtc: defaultExpiry,
      };
      receipts.set(key, recorded);
      return recorded;
    },

    restoreReceipts(deviceId, platformReceiptIds) {
      const collected: Entitlement[] = [];
      for (const rid of platformReceiptIds) {
        const rec = receipts.get(receiptKey(deviceId, rid));
        if (rec) collected.push(...rec.entitlements);
      }
      // Also surface any pre-seeded entitlements for the device (e.g. a
      // promotional grant the operator added through the store API).
      const seeded = entitlementsByDevice.get(deviceId) ?? [];
      return {
        entitlements: [...seeded, ...collected],
        expiryUtc: defaultExpiry,
      };
    },

    getModeration(): ModerationPayload {
      return {
        disabledSegmentIds: [...disabled],
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}

function manifestKey(bundleId: string, version: string): string {
  return `${bundleId}@${version}`;
}

function assetKey(bundleId: string, version: string, path: string): string {
  return `${bundleId}@${version}::${path}`;
}

function receiptKey(deviceId: string, platformReceiptId: string): string {
  return `${deviceId}::${platformReceiptId}`;
}

function makeMemoryReadResult(bytes: Buffer): AssetReadResult {
  return {
    sizeBytes: bytes.length,
    read: async (start, end) => bytes.subarray(start, end + 1),
  };
}

function makeFileReadResult(filePath: string, size: number): AssetReadResult {
  return {
    sizeBytes: size,
    read: async (start, end) => {
      const fh = await readFile(filePath);
      return fh.subarray(start, end + 1);
    },
  };
}

/**
 * Refuse to traverse outside `root`. Returns undefined if any segment
 * resolves above the root or contains a NUL byte.
 */
function safeJoin(root: string, ...parts: string[]): string | undefined {
  for (const p of parts) {
    if (p.length === 0 || p.includes('\0')) return undefined;
  }
  const joined = normalize(join(root, ...parts));
  const normalizedRoot = normalize(root);
  // Make sure the joined path is still under the root.
  if (joined !== normalizedRoot && !joined.startsWith(normalizedRoot + sep)) {
    return undefined;
  }
  return joined;
}
