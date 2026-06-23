/**
 * Entitlement_Client — resolves Device_Id → EntitlementSet via the
 * Entitlement_Service backend.
 *
 * Responsibilities:
 * 1. Generate a Device_Id (UUID v4) on first launch and persist it in
 *    secure storage (SQLite `device_id` table). (Req 13.1)
 * 2. Resolve entitlements via `GET /v1/entitlements?deviceId=...`. (Req 13.2)
 * 3. Cache entitlements with declared expiry in SQLite
 *    (`entitlement_cache` table). (Req 13.3)
 * 4. During an active tour, read from cache only — never make network
 *    calls. (Req 3.2, enforced by the HTTP client wrapper)
 * 5. Submit platform receipts for validation via
 *    `POST /v1/entitlements/receipt`. (Req 13.4)
 * 6. Support purchase restore via `POST /v1/entitlements/restore`. (Req 13.5)
 * 7. Never require email/phone/social login. (Req 13.6)
 *
 * The client uses the HTTP wrapper from task 6.2 as its transport, which
 * means all requests automatically respect the tour-active block and
 * metered/unmetered policy.
 *
 * @see Requirements 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 14.2, 14.3
 */

import type { HttpClient } from './http-client';

// ---------------------------------------------------------------------------
// Wire types (mirror backend response shapes)
// ---------------------------------------------------------------------------

/** A single entitlement decision from the backend. */
export interface Entitlement {
  readonly tier: 'free' | 'time_pass' | 'token_unlock' | 'b2b';
  readonly bundleId?: string;
  readonly grantedAt: string;
  readonly expiresAt?: string;
}

/** Payload of `GET /v1/entitlements`. */
export interface EntitlementsPayload {
  readonly deviceId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  /** ISO-8601 UTC; the cache-honoring deadline. */
  readonly expiryUtc: string;
}

/** Signed envelope wrapping a payload from the backend. */
export interface SignedEnvelope<T> {
  readonly payload: T;
  readonly signature: string;
  readonly kid: string;
}

/** Payload of `POST /v1/entitlements/receipt`. */
export interface ReceiptResponsePayload {
  readonly deviceId: string;
  readonly platformReceiptId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  readonly expiryUtc: string;
}

/** Payload of `POST /v1/entitlements/restore`. */
export interface RestoreResponsePayload {
  readonly deviceId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  readonly expiryUtc: string;
}

// ---------------------------------------------------------------------------
// Storage interface (subset of Storage_Manager the client needs)
// ---------------------------------------------------------------------------

/**
 * Subset of Storage_Manager that the Entitlement_Client reads through for
 * Device_Id persistence and entitlement caching.
 */
export interface EntitlementStorageProvider {
  /** Read the persisted Device_Id, or null if not yet generated. */
  getDeviceId(): Promise<string | null>;

  /** Persist a newly generated Device_Id. */
  saveDeviceId(deviceId: string): Promise<void>;

  /**
   * Read the cached entitlement payload, or null if no cache exists.
   * Returns the raw payload and its expiry timestamp (UTC seconds).
   */
  getCachedEntitlements(): Promise<CachedEntitlementEntry | null>;

  /**
   * Persist the entitlement payload with its declared expiry.
   * @param deviceId - The Device_Id this cache belongs to.
   * @param payload - The full signed payload (JWS or JSON string).
   * @param expiryUtcSeconds - UTC seconds since epoch when the cache expires.
   */
  saveCachedEntitlements(
    deviceId: string,
    payload: string,
    expiryUtcSeconds: number,
  ): Promise<void>;
}

/** Shape of a cached entitlement entry from storage. */
export interface CachedEntitlementEntry {
  readonly deviceId: string;
  readonly payload: string;
  readonly expiryUtcSeconds: number;
  readonly fetchedAtUtcSeconds: number;
}

// ---------------------------------------------------------------------------
// UUID v4 generator interface
// ---------------------------------------------------------------------------

/**
 * Function that generates a UUID v4 string. Injected so tests can
 * provide deterministic IDs and production can use `crypto.randomUUID()`.
 */
export type UuidGenerator = () => string;

// ---------------------------------------------------------------------------
// Clock interface
// ---------------------------------------------------------------------------

/**
 * Returns the current time as UTC seconds since epoch.
 * Injected so tests can control time.
 */
export type NowUtcSeconds = () => number;

// ---------------------------------------------------------------------------
// Entitlement_Client options
// ---------------------------------------------------------------------------

export interface EntitlementClientOptions {
  /** Base URL of the Entitlement_Service (e.g. `https://tramio.app`). */
  readonly baseUrl: string;
  /** The HTTP client wrapper (task 6.2) used as the transport layer. */
  readonly http: HttpClient;
  /** Storage provider for Device_Id and entitlement cache. */
  readonly storage: EntitlementStorageProvider;
  /** UUID v4 generator. Defaults to `crypto.randomUUID()`. */
  readonly generateUuid?: UuidGenerator;
  /** Clock function. Defaults to `() => Math.floor(Date.now() / 1000)`. */
  readonly now?: NowUtcSeconds;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Error thrown when the backend returns an unexpected HTTP status. */
export class EntitlementHttpError extends Error {
  public readonly status: number;
  public readonly url: string;
  constructor(url: string, status: number) {
    super(`Entitlement request failed: ${url} returned HTTP ${status}`);
    this.name = 'EntitlementHttpError';
    this.status = status;
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// Resolved entitlement set (what consumers see)
// ---------------------------------------------------------------------------

/** The resolved entitlement set exposed to the Tour_Engine and UI. */
export interface ResolvedEntitlements {
  readonly deviceId: string;
  readonly entitlements: ReadonlyArray<Entitlement>;
  /** UTC seconds since epoch; cache is valid until this time. */
  readonly expiryUtcSeconds: number;
  /** Whether this result came from cache (true) or a fresh network call (false). */
  readonly fromCache: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create an Entitlement_Client instance.
 *
 * The client uses the HTTP wrapper from task 6.2 as its transport, which
 * means all requests automatically respect the tour-active block. During
 * an active tour, `resolveEntitlements()` reads from cache only.
 */
export function createEntitlementClient(opts: EntitlementClientOptions) {
  const { baseUrl, http, storage } = opts;
  const generateUuid: UuidGenerator =
    opts.generateUuid ?? (() => crypto.randomUUID());
  const now: NowUtcSeconds =
    opts.now ?? (() => Math.floor(Date.now() / 1000));

  // Strip trailing slash from baseUrl for consistent URL construction.
  const base = baseUrl.replace(/\/+$/, '');

  // In-memory Device_Id cache to avoid repeated SQLite reads.
  let cachedDeviceId: string | null = null;

  /**
   * Get or generate the Device_Id.
   *
   * On first launch, generates a UUID v4 and persists it. On subsequent
   * launches, reads from storage. The Device_Id is cached in memory for
   * the lifetime of this client instance.
   *
   * @see Requirement 13.1
   */
  async function getDeviceId(): Promise<string> {
    if (cachedDeviceId !== null) {
      return cachedDeviceId;
    }

    const stored = await storage.getDeviceId();
    if (stored !== null) {
      cachedDeviceId = stored;
      return stored;
    }

    // First launch: generate and persist.
    const newId = generateUuid();
    await storage.saveDeviceId(newId);
    cachedDeviceId = newId;
    return newId;
  }

  /**
   * Resolve entitlements for this device.
   *
   * Strategy:
   * 1. If a valid (unexpired) cache entry exists, return it.
   * 2. Otherwise, fetch from the backend and update the cache.
   * 3. If the network call fails and a stale cache exists, return the
   *    stale cache (Req 13.3: honor cached entitlement until declared expiry).
   * 4. If no cache exists and the network fails, throw.
   *
   * During an active tour, the HTTP wrapper will throw
   * `TourActiveBlockError` on any outbound request, so this method
   * will naturally fall through to the cache path.
   *
   * @see Requirements 13.2, 13.3, 14.2, 14.3
   */
  async function resolveEntitlements(): Promise<ResolvedEntitlements> {
    const deviceId = await getDeviceId();
    const currentTime = now();

    // Check cache first.
    const cached = await storage.getCachedEntitlements();
    if (cached !== null && cached.expiryUtcSeconds > currentTime) {
      const parsed = JSON.parse(cached.payload) as EntitlementsPayload;
      // Filter out expired time-pass entitlements (Req 14.3).
      const validEntitlements = filterExpiredEntitlements(parsed.entitlements, currentTime);
      return {
        deviceId,
        entitlements: validEntitlements,
        expiryUtcSeconds: cached.expiryUtcSeconds,
        fromCache: true,
      };
    }

    // Attempt network fetch.
    try {
      const url = `${base}/v1/entitlements?deviceId=${encodeURIComponent(deviceId)}`;
      const response = await http.request({ url, intent: 'probe' });

      if (response.status !== 200) {
        throw new EntitlementHttpError(url, response.status);
      }

      const envelope = JSON.parse(
        new TextDecoder().decode(response.body),
      ) as SignedEnvelope<EntitlementsPayload>;

      const payload = envelope.payload;
      const expiryUtcSeconds = Math.floor(
        new Date(payload.expiryUtc).getTime() / 1000,
      );

      // Persist to cache.
      await storage.saveCachedEntitlements(
        deviceId,
        JSON.stringify(payload),
        expiryUtcSeconds,
      );

      // Filter out expired time-pass entitlements (Req 14.3).
      const validEntitlements = filterExpiredEntitlements(payload.entitlements, currentTime);

      return {
        deviceId,
        entitlements: validEntitlements,
        expiryUtcSeconds,
        fromCache: false,
      };
    } catch (err) {
      // If network fails but we have a stale cache, honor it until expiry (Req 13.3).
      if (cached !== null) {
        const parsed = JSON.parse(cached.payload) as EntitlementsPayload;
        const validEntitlements = filterExpiredEntitlements(parsed.entitlements, currentTime);
        return {
          deviceId,
          entitlements: validEntitlements,
          expiryUtcSeconds: cached.expiryUtcSeconds,
          fromCache: true,
        };
      }
      throw err;
    }
  }

  /**
   * Submit a platform receipt for validation.
   *
   * The backend validates the receipt and grants entitlements. The
   * response updates the local entitlement cache. Receipt validation
   * is idempotent on `(deviceId, platformReceiptId)`.
   *
   * @see Requirement 13.4
   */
  async function submitReceipt(
    platformReceiptId: string,
    platformReceipt: string,
  ): Promise<ResolvedEntitlements> {
    const deviceId = await getDeviceId();

    const url = `${base}/v1/entitlements/receipt`;
    const body = JSON.stringify({
      deviceId,
      platformReceiptId,
      platformReceipt,
    });

    const response = await http.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      intent: 'probe',
    });

    if (response.status !== 200) {
      throw new EntitlementHttpError(url, response.status);
    }

    const envelope = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as SignedEnvelope<ReceiptResponsePayload>;

    const payload = envelope.payload;
    const expiryUtcSeconds = Math.floor(
      new Date(payload.expiryUtc).getTime() / 1000,
    );

    // Build the entitlements payload for caching.
    const entitlementsPayload: EntitlementsPayload = {
      deviceId: payload.deviceId,
      entitlements: payload.entitlements,
      expiryUtc: payload.expiryUtc,
    };

    // Update cache with the new entitlements.
    await storage.saveCachedEntitlements(
      deviceId,
      JSON.stringify(entitlementsPayload),
      expiryUtcSeconds,
    );

    const currentTime = now();
    const validEntitlements = filterExpiredEntitlements(payload.entitlements, currentTime);

    return {
      deviceId,
      entitlements: validEntitlements,
      expiryUtcSeconds,
      fromCache: false,
    };
  }

  /**
   * Restore purchases by re-querying the backend with platform receipts.
   *
   * @see Requirement 13.5
   */
  async function restorePurchases(
    receipts: ReadonlyArray<{ platformReceiptId: string; platformReceipt: string }>,
  ): Promise<ResolvedEntitlements> {
    const deviceId = await getDeviceId();

    const url = `${base}/v1/entitlements/restore`;
    const body = JSON.stringify({
      deviceId,
      receipts,
    });

    const response = await http.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      intent: 'probe',
    });

    if (response.status !== 200) {
      throw new EntitlementHttpError(url, response.status);
    }

    const envelope = JSON.parse(
      new TextDecoder().decode(response.body),
    ) as SignedEnvelope<RestoreResponsePayload>;

    const payload = envelope.payload;
    const expiryUtcSeconds = Math.floor(
      new Date(payload.expiryUtc).getTime() / 1000,
    );

    // Build the entitlements payload for caching.
    const entitlementsPayload: EntitlementsPayload = {
      deviceId: payload.deviceId,
      entitlements: payload.entitlements,
      expiryUtc: payload.expiryUtc,
    };

    // Update cache with the restored entitlements.
    await storage.saveCachedEntitlements(
      deviceId,
      JSON.stringify(entitlementsPayload),
      expiryUtcSeconds,
    );

    const currentTime = now();
    const validEntitlements = filterExpiredEntitlements(payload.entitlements, currentTime);

    return {
      deviceId,
      entitlements: validEntitlements,
      expiryUtcSeconds,
      fromCache: false,
    };
  }

  /**
   * Read entitlements from cache only. Used during active tours where
   * network calls are blocked.
   *
   * Returns null if no cache exists or the cache has expired.
   *
   * @see Requirement 3.2 (no network during tour)
   */
  async function getCachedEntitlements(): Promise<ResolvedEntitlements | null> {
    const deviceId = await getDeviceId();
    const currentTime = now();

    const cached = await storage.getCachedEntitlements();
    if (cached === null || cached.expiryUtcSeconds <= currentTime) {
      return null;
    }

    const parsed = JSON.parse(cached.payload) as EntitlementsPayload;
    const validEntitlements = filterExpiredEntitlements(parsed.entitlements, currentTime);

    return {
      deviceId,
      entitlements: validEntitlements,
      expiryUtcSeconds: cached.expiryUtcSeconds,
      fromCache: true,
    };
  }

  return {
    getDeviceId,
    resolveEntitlements,
    submitReceipt,
    restorePurchases,
    getCachedEntitlements,
  };
}

export type EntitlementClient = ReturnType<typeof createEntitlementClient>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter out entitlements whose individual `expiresAt` has passed.
 * This enforces Req 14.3: time-pass entitlements are only honored
 * while `now ≤ expiry`.
 */
function filterExpiredEntitlements(
  entitlements: ReadonlyArray<Entitlement>,
  currentTimeUtcSeconds: number,
): ReadonlyArray<Entitlement> {
  return entitlements.filter((e) => {
    if (e.expiresAt === undefined) {
      // Permanent grant (e.g. free tier) — always valid.
      return true;
    }
    const expirySeconds = Math.floor(new Date(e.expiresAt).getTime() / 1000);
    return currentTimeUtcSeconds <= expirySeconds;
  });
}
