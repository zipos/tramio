/**
 * Catalog_Client — thin REST client over the Catalog_Service.
 *
 * Responsibilities:
 * 1. Probe for available bundles and versions (GET /v1/catalog).
 * 2. Fetch the signed manifest lock file (GET /v1/catalog/{bundleId}/{version}/manifest.lock.json).
 * 3. Fetch individual assets with HTTP Range support for resume
 *    (GET /v1/catalog/{bundleId}/{version}/asset/{path}).
 * 4. Refresh moderation state (GET /v1/moderation).
 * 5. Surface "update available" without auto-downloading on metered connections.
 *
 * The client reads through Storage_Manager for cached moderation state and
 * uses the HTTP client wrapper (task 6.2) as the transport layer, which
 * enforces the tour-active block and metered/unmetered policy.
 *
 * @see Requirements 3.6, 14.6, 18.1, 20.3
 */

import type { HttpClient, NetworkInfoProvider } from './http-client';

// ---------------------------------------------------------------------------
// Wire types (mirror backend response shapes)
// ---------------------------------------------------------------------------

/** A single bundle entry in the catalog listing. */
export interface CatalogBundleEntry {
  readonly bundleId: string;
  readonly version: string;
  readonly sizeBytes: number;
  readonly requiredAppVersion: string;
}

/** Payload of `GET /v1/catalog`. */
export interface CatalogListPayload {
  readonly bundles: ReadonlyArray<CatalogBundleEntry>;
  readonly fetchedAt: string;
}

/** Signed envelope wrapping a payload from the backend. */
export interface SignedEnvelope<T> {
  readonly payload: T;
  readonly signature: string;
  readonly kid: string;
}

/** A single asset entry in the manifest lock. */
export interface ManifestLockAsset {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly protected?: boolean;
  readonly encryption?: {
    readonly scheme: 'aes-256-gcm-framed-v1';
    readonly chunkSize?: number;
    readonly plaintextSha256?: string;
  };
}

/** Payload of `GET /v1/catalog/{bundleId}/{version}/manifest.lock.json`. */
export interface ManifestLockPayload {
  readonly bundleId: string;
  readonly version: string;
  readonly assets: ReadonlyArray<ManifestLockAsset>;
  readonly createdAt: string;
}

/** Moderation payload from `GET /v1/moderation`. */
export interface ModerationPayload {
  readonly disabledSegmentIds: ReadonlyArray<string>;
  readonly fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Update notification types
// ---------------------------------------------------------------------------

/** Describes a bundle that has a newer version available than what is installed locally. */
export interface UpdateAvailable {
  readonly bundleId: string;
  readonly currentVersion: string | null;
  readonly availableVersion: string;
  readonly sizeBytes: number;
}

/** Result of a catalog probe, including update availability information. */
export interface ProbeResult {
  readonly catalog: CatalogListPayload;
  /** Bundles with newer versions than what is installed locally. */
  readonly updatesAvailable: ReadonlyArray<UpdateAvailable>;
  /** True when the connection is metered and auto-download is suppressed. */
  readonly meteredConnectionSuppressed: boolean;
}

// ---------------------------------------------------------------------------
// Asset fetch types
// ---------------------------------------------------------------------------

/** Result of a ranged asset fetch. */
export interface AssetFetchResult {
  /** The fetched bytes (may be a partial range). */
  readonly data: Uint8Array;
  /** HTTP status: 200 for full content, 206 for partial content. */
  readonly status: number;
  /** Total size of the asset in bytes (from Content-Range or Content-Length). */
  readonly totalBytes: number;
  /** Start byte of the returned range (0 for full content). */
  readonly rangeStart: number;
  /** End byte (inclusive) of the returned range. */
  readonly rangeEnd: number;
}

// ---------------------------------------------------------------------------
// Storage interface (subset of Storage_Manager the client needs)
// ---------------------------------------------------------------------------

/**
 * Subset of Storage_Manager that the Catalog_Client reads through for
 * cached moderation state and installed pack versions.
 */
export interface CatalogStorageProvider {
  /** Returns the list of installed pack versions as `{ bundleId, version }` pairs. */
  getInstalledPacks(): Promise<ReadonlyArray<{ bundleId: string; version: string }>>;

  /** Persist the moderation snapshot to SQLite. */
  saveModerationSnapshot(payload: ModerationPayload): Promise<void>;

  /** Read the last persisted moderation snapshot, or null if none exists. */
  getModerationSnapshot(): Promise<ModerationPayload | null>;
}

// ---------------------------------------------------------------------------
// Catalog_Client options
// ---------------------------------------------------------------------------

export interface CatalogClientOptions {
  /** Base URL of the Catalog_Service (e.g. `https://tramio.app`). */
  readonly baseUrl: string;
  /** The HTTP client wrapper (task 6.2) used as the transport layer. */
  readonly http: HttpClient;
  /** Network info provider for metered/unmetered detection. */
  readonly networkInfo: NetworkInfoProvider;
  /** Storage provider for reading installed packs and caching moderation state. */
  readonly storage: CatalogStorageProvider;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown when the backend returns an unexpected HTTP status. */
export class CatalogHttpError extends Error {
  public readonly status: number;
  public readonly url: string;
  constructor(url: string, status: number) {
    super(`Catalog request failed: ${url} returned HTTP ${status}`);
    this.name = 'CatalogHttpError';
    this.status = status;
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a Catalog_Client instance.
 *
 * The client uses the HTTP wrapper from task 6.2 as its transport, which
 * means all requests automatically respect the tour-active block and
 * metered/unmetered policy. The Catalog_Client adds the "update available"
 * surfacing logic on top.
 */
export function createCatalogClient(opts: CatalogClientOptions) {
  const { baseUrl, http, networkInfo, storage } = opts;

  // Strip trailing slash from baseUrl for consistent URL construction.
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * Probe the catalog for available bundles and surface update notifications.
   *
   * This is a lightweight probe (intent: 'probe') so it is allowed on any
   * connection type. However, if the connection is metered, the client
   * surfaces "update available" without triggering auto-download.
   *
   * @see Requirement 3.6: check for updates on any connection, notify
   *      without auto-downloading on metered.
   * @see Requirement 18.1: Catalog_Service publishes version timestamps.
   */
  async function probe(): Promise<ProbeResult> {
    const url = `${base}/v1/catalog`;
    const response = await http.request({ url, intent: 'probe' });

    if (response.status !== 200) {
      throw new CatalogHttpError(url, response.status);
    }

    const envelope = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as SignedEnvelope<CatalogListPayload>;

    const catalog = envelope.payload;
    const isMetered = !networkInfo.isUnmetered();

    // Compare against installed packs to determine which have updates.
    const installed = await storage.getInstalledPacks();
    const installedMap = new Map<string, string>();
    for (const pack of installed) {
      installedMap.set(pack.bundleId, pack.version);
    }

    const updatesAvailable: UpdateAvailable[] = [];
    for (const entry of catalog.bundles) {
      const currentVersion = installedMap.get(entry.bundleId) ?? null;
      if (currentVersion !== entry.version) {
        updatesAvailable.push({
          bundleId: entry.bundleId,
          currentVersion,
          availableVersion: entry.version,
          sizeBytes: entry.sizeBytes,
        });
      }
    }

    return {
      catalog,
      updatesAvailable,
      meteredConnectionSuppressed: isMetered && updatesAvailable.length > 0,
    };
  }

  /**
   * Fetch the signed manifest lock file for a specific bundle version.
   *
   * Uses intent 'probe' since the lock file is small metadata, not a
   * large download. The returned envelope includes the signature for
   * downstream verification by the Storage_Manager/downloader.
   *
   * @see Requirement 3.6
   */
  async function fetchManifestLock(
    bundleId: string,
    version: string,
  ): Promise<SignedEnvelope<ManifestLockPayload>> {
    const url = `${base}/v1/catalog/${encodeURIComponent(bundleId)}/${encodeURIComponent(version)}/manifest.lock.json`;
    const response = await http.request({ url, intent: 'probe' });

    if (response.status !== 200) {
      throw new CatalogHttpError(url, response.status);
    }

    const envelope = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as SignedEnvelope<ManifestLockPayload>;

    return envelope;
  }

  /**
   * Fetch an individual asset with HTTP Range support for resume.
   *
   * Uses intent 'download' since assets can be large (audio, tiles).
   * The HTTP client wrapper will block this on metered connections unless
   * `allowMetered` is set.
   *
   * @param bundleId - The bundle identifier.
   * @param version - The bundle version.
   * @param assetPath - Pack-relative path (e.g. `audio/poi-rynek.en.m4a`).
   * @param rangeStart - Optional byte offset to resume from.
   * @param rangeEnd - Optional end byte (inclusive) for partial fetch.
   * @param allowMetered - When true, allows download on metered connections.
   */
  async function fetchAsset(
    bundleId: string,
    version: string,
    assetPath: string,
    options?: {
      rangeStart?: number;
      rangeEnd?: number;
      allowMetered?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<AssetFetchResult> {
    const { rangeStart, rangeEnd, allowMetered = false, signal } = options ?? {};

    const url = `${base}/v1/catalog/${encodeURIComponent(bundleId)}/${encodeURIComponent(version)}/asset/${assetPath}`;

    const headers: Record<string, string> = {};
    if (rangeStart !== undefined) {
      const rangeValue =
        rangeEnd !== undefined
          ? `bytes=${rangeStart}-${rangeEnd}`
          : `bytes=${rangeStart}-`;
      headers['Range'] = rangeValue;
    }

    const requestOpts: Parameters<typeof http.request>[0] = {
      url,
      headers,
      intent: 'download',
      allowMetered,
    };
    if (signal) {
      requestOpts.signal = signal;
    }

    const response = await http.request(requestOpts);

    if (response.status !== 200 && response.status !== 206) {
      throw new CatalogHttpError(url, response.status);
    }

    // Parse Content-Range header for 206 responses.
    let totalBytes: number;
    let actualRangeStart: number;
    let actualRangeEnd: number;

    if (response.status === 206 && response.headers['content-range']) {
      // Format: "bytes start-end/total"
      const match = response.headers['content-range'].match(
        /^bytes\s+(\d+)-(\d+)\/(\d+)$/,
      );
      if (match && match[1] && match[2] && match[3]) {
        actualRangeStart = parseInt(match[1], 10);
        actualRangeEnd = parseInt(match[2], 10);
        totalBytes = parseInt(match[3], 10);
      } else {
        // Fallback: use content-length and requested range.
        totalBytes = parseInt(response.headers['content-length'] ?? '0', 10);
        actualRangeStart = rangeStart ?? 0;
        actualRangeEnd = actualRangeStart + response.body.length - 1;
      }
    } else {
      // Full content (200).
      totalBytes = response.body.length;
      actualRangeStart = 0;
      actualRangeEnd = response.body.length > 0 ? response.body.length - 1 : 0;
    }

    return {
      data: response.body,
      status: response.status,
      totalBytes,
      rangeStart: actualRangeStart,
      rangeEnd: actualRangeEnd,
    };
  }

  /**
   * Refresh the moderation state from the Catalog_Service.
   *
   * Fetches the current moderation snapshot and persists it through
   * Storage_Manager. The Tour_Engine reads this snapshot to skip
   * disabled B2B segments on subsequent triggers.
   *
   * Uses intent 'probe' since the moderation payload is small.
   *
   * @see Requirement 14.6: moderation flag allows remote disable.
   * @see Requirement 20.3: refresh moderation on next contact.
   */
  async function refreshModeration(): Promise<ModerationPayload> {
    const url = `${base}/v1/moderation`;
    const response = await http.request({ url, intent: 'probe' });

    if (response.status !== 200) {
      throw new CatalogHttpError(url, response.status);
    }

    const envelope = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as SignedEnvelope<ModerationPayload>;

    const payload = envelope.payload;

    // Persist the moderation snapshot through Storage_Manager.
    await storage.saveModerationSnapshot(payload);

    return payload;
  }

  /**
   * Get the cached moderation state from Storage_Manager.
   *
   * Used by the Tour_Engine to check segment moderation status without
   * making a network call (important during active tours where network
   * is blocked).
   */
  async function getCachedModeration(): Promise<ModerationPayload | null> {
    return storage.getModerationSnapshot();
  }

  return {
    probe,
    fetchManifestLock,
    fetchAsset,
    refreshModeration,
    getCachedModeration,
  };
}

export type CatalogClient = ReturnType<typeof createCatalogClient>;
