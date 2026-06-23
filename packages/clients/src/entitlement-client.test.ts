import {
  createEntitlementClient,
  EntitlementHttpError,
  type CachedEntitlementEntry,
  type EntitlementStorageProvider,
  type EntitlementsPayload,
  type SignedEnvelope,
  type ReceiptResponsePayload,
  type RestoreResponsePayload,
} from './entitlement-client';
import {
  createHttpClient,
  TourActiveBlockError,
  type FetchImpl,
  type NetworkInfoProvider,
  type TourStateProvider,
} from './http-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTourState(active = false): TourStateProvider {
  return { isTourActive: () => active };
}

function makeNetworkInfo(unmetered = true): NetworkInfoProvider {
  return { isUnmetered: () => unmetered };
}

function makeEnvelope<T>(payload: T): SignedEnvelope<T> {
  return { payload, signature: 'fake-sig', kid: 'test-kid' };
}

function jsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function makeStorage(opts?: {
  deviceId?: string | null;
  cached?: CachedEntitlementEntry | null;
}): EntitlementStorageProvider & {
  savedDeviceId: string | null;
  savedCache: { deviceId: string; payload: string; expiryUtcSeconds: number } | null;
} {
  const store = {
    savedDeviceId: opts?.deviceId ?? null,
    savedCache: null as { deviceId: string; payload: string; expiryUtcSeconds: number } | null,
    _cached: opts?.cached ?? null,
    async getDeviceId() {
      return store.savedDeviceId;
    },
    async saveDeviceId(deviceId: string) {
      store.savedDeviceId = deviceId;
    },
    async getCachedEntitlements(): Promise<CachedEntitlementEntry | null> {
      if (store.savedCache) {
        return {
          deviceId: store.savedCache.deviceId,
          payload: store.savedCache.payload,
          expiryUtcSeconds: store.savedCache.expiryUtcSeconds,
          fetchedAtUtcSeconds: Math.floor(Date.now() / 1000),
        };
      }
      return store._cached;
    },
    async saveCachedEntitlements(
      deviceId: string,
      payload: string,
      expiryUtcSeconds: number,
    ) {
      store.savedCache = { deviceId, payload, expiryUtcSeconds };
    },
  };
  return store;
}

function makeFetch(
  responses: Record<string, { status: number; body: Uint8Array; headers?: Record<string, string | null> }>,
): FetchImpl {
  return async (url, _init) => {
    let matched: { status: number; body: Uint8Array; headers?: Record<string, string | null> } | undefined;
    for (const [pattern, resp] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        matched = resp;
        break;
      }
    }
    if (!matched) {
      matched = { status: 404, body: jsonBytes({ error: 'not_found' }) };
    }
    const responseHeaders = matched.headers ?? {};
    const bodyRef = matched.body;
    return {
      status: matched.status,
      headers: {
        get: (name: string) => {
          const val = responseHeaders[name.toLowerCase()];
          return val !== undefined ? val : null;
        },
      },
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        const copy = new ArrayBuffer(bodyRef.byteLength);
        new Uint8Array(copy).set(bodyRef);
        return copy;
      },
    };
  };
}

function createTestClient(opts: {
  fetchResponses?: Record<string, { status: number; body: Uint8Array; headers?: Record<string, string | null> }>;
  tourActive?: boolean;
  unmetered?: boolean;
  deviceId?: string | null;
  cached?: CachedEntitlementEntry | null;
  generateUuid?: () => string;
  now?: () => number;
}) {
  const {
    fetchResponses = {},
    tourActive = false,
    unmetered = true,
    deviceId = null,
    cached = null,
    generateUuid = () => 'test-device-uuid-v4',
    now = () => 1705312800, // 2024-01-15T10:00:00Z
  } = opts;

  const networkInfo = makeNetworkInfo(unmetered);
  const http = createHttpClient({
    tourState: makeTourState(tourActive),
    networkInfo,
    fetch: makeFetch(fetchResponses),
  });
  const storage = makeStorage({ deviceId, cached });

  const client = createEntitlementClient({
    baseUrl: 'https://tramio.app',
    http,
    storage,
    generateUuid,
    now,
  });

  return { client, storage, networkInfo };
}

// ---------------------------------------------------------------------------
// getDeviceId()
// ---------------------------------------------------------------------------

describe('EntitlementClient.getDeviceId', () => {
  it('generates a new Device_Id on first launch and persists it', async () => {
    const { client, storage } = createTestClient({
      generateUuid: () => 'fresh-device-id-001',
    });

    const id = await client.getDeviceId();
    expect(id).toBe('fresh-device-id-001');
    expect(storage.savedDeviceId).toBe('fresh-device-id-001');
  });

  it('returns the persisted Device_Id on subsequent calls', async () => {
    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      generateUuid: () => 'should-not-be-called',
    });

    const id = await client.getDeviceId();
    expect(id).toBe('existing-device-id');
  });

  it('caches Device_Id in memory after first read', async () => {
    let callCount = 0;
    const storage = makeStorage({ deviceId: 'persisted-id' });
    const originalGet = storage.getDeviceId.bind(storage);
    storage.getDeviceId = async () => {
      callCount++;
      return originalGet();
    };

    const http = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: makeFetch({}),
    });

    const client = createEntitlementClient({
      baseUrl: 'https://tramio.app',
      http,
      storage,
      generateUuid: () => 'unused',
      now: () => 1705312800,
    });

    await client.getDeviceId();
    await client.getDeviceId();
    await client.getDeviceId();
    // Only one storage read should happen.
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveEntitlements()
// ---------------------------------------------------------------------------

describe('EntitlementClient.resolveEntitlements', () => {
  const entitlementsPayload: EntitlementsPayload = {
    deviceId: 'existing-device-id',
    entitlements: [
      { tier: 'free', grantedAt: '2024-01-01T00:00:00Z' },
      { tier: 'time_pass', grantedAt: '2024-01-14T00:00:00Z', expiresAt: '2024-01-16T00:00:00Z' },
    ],
    expiryUtc: '2024-01-16T00:00:00Z',
  };

  it('fetches entitlements from the backend and caches them', async () => {
    const { client, storage } = createTestClient({
      deviceId: 'existing-device-id',
      fetchResponses: {
        '/v1/entitlements': {
          status: 200,
          body: jsonBytes(makeEnvelope(entitlementsPayload)),
        },
      },
    });

    const result = await client.resolveEntitlements();
    expect(result.deviceId).toBe('existing-device-id');
    expect(result.fromCache).toBe(false);
    expect(result.entitlements).toHaveLength(2);
    expect(storage.savedCache).not.toBeNull();
    expect(storage.savedCache!.deviceId).toBe('existing-device-id');
  });

  it('returns cached entitlements when cache is valid', async () => {
    const cachedPayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00Z' }],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(cachedPayload),
        expiryUtcSeconds: 1705708800, // 2024-01-20T00:00:00Z
        fetchedAtUtcSeconds: 1705312800,
      },
      // No fetch responses — should not hit network.
      fetchResponses: {},
    });

    const result = await client.resolveEntitlements();
    expect(result.fromCache).toBe(true);
    expect(result.entitlements).toHaveLength(1);
    expect(result.entitlements[0]!.tier).toBe('free');
  });

  it('fetches from network when cache is expired', async () => {
    const expiredPayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00Z' }],
      expiryUtc: '2024-01-10T00:00:00Z',
    };

    const freshPayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [
        { tier: 'free', grantedAt: '2024-01-01T00:00:00Z' },
        { tier: 'time_pass', grantedAt: '2024-01-14T00:00:00Z', expiresAt: '2024-01-16T00:00:00Z' },
      ],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(expiredPayload),
        expiryUtcSeconds: 1704844800, // 2024-01-10T00:00:00Z (expired)
        fetchedAtUtcSeconds: 1704758400,
      },
      fetchResponses: {
        '/v1/entitlements': {
          status: 200,
          body: jsonBytes(makeEnvelope(freshPayload)),
        },
      },
    });

    const result = await client.resolveEntitlements();
    expect(result.fromCache).toBe(false);
    expect(result.entitlements).toHaveLength(2);
  });

  it('falls back to stale cache when network fails', async () => {
    const stalePayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00Z' }],
      expiryUtc: '2024-01-10T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(stalePayload),
        expiryUtcSeconds: 1704844800, // expired
        fetchedAtUtcSeconds: 1704758400,
      },
      fetchResponses: {
        '/v1/entitlements': { status: 500, body: jsonBytes({ error: 'internal' }) },
      },
    });

    const result = await client.resolveEntitlements();
    expect(result.fromCache).toBe(true);
    expect(result.entitlements).toHaveLength(1);
  });

  it('throws when network fails and no cache exists', async () => {
    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      fetchResponses: {
        '/v1/entitlements': { status: 500, body: jsonBytes({ error: 'internal' }) },
      },
    });

    await expect(client.resolveEntitlements()).rejects.toThrow(EntitlementHttpError);
  });

  it('filters out expired time-pass entitlements (Req 14.3)', async () => {
    const payload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [
        { tier: 'free', grantedAt: '2024-01-01T00:00:00Z' },
        // This time_pass expired before "now" (1705312800 = 2024-01-15T10:00:00Z)
        { tier: 'time_pass', grantedAt: '2024-01-10T00:00:00Z', expiresAt: '2024-01-12T00:00:00Z' },
        // This time_pass is still valid
        { tier: 'time_pass', grantedAt: '2024-01-14T00:00:00Z', expiresAt: '2024-01-16T00:00:00Z' },
      ],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      fetchResponses: {
        '/v1/entitlements': {
          status: 200,
          body: jsonBytes(makeEnvelope(payload)),
        },
      },
    });

    const result = await client.resolveEntitlements();
    expect(result.entitlements).toHaveLength(2);
    expect(result.entitlements[0]!.tier).toBe('free');
    expect(result.entitlements[1]!.tier).toBe('time_pass');
    expect(result.entitlements[1]!.expiresAt).toBe('2024-01-16T00:00:00Z');
  });

  it('uses Device_Id in the query parameter', async () => {
    let capturedUrl = '';
    const mockFetch: FetchImpl = async (url, _init) => {
      capturedUrl = url;
      const payload: EntitlementsPayload = {
        deviceId: 'my-device',
        entitlements: [],
        expiryUtc: '2024-01-20T00:00:00Z',
      };
      const body = jsonBytes(makeEnvelope(payload));
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async (): Promise<ArrayBuffer> => {
          const copy = new ArrayBuffer(body.byteLength);
          new Uint8Array(copy).set(body);
          return copy;
        },
      };
    };

    const http = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: mockFetch,
    });

    const storage = makeStorage({ deviceId: 'my-device' });
    const client = createEntitlementClient({
      baseUrl: 'https://tramio.app',
      http,
      storage,
      now: () => 1705312800,
    });

    await client.resolveEntitlements();
    expect(capturedUrl).toContain('deviceId=my-device');
  });
});

// ---------------------------------------------------------------------------
// submitReceipt()
// ---------------------------------------------------------------------------

describe('EntitlementClient.submitReceipt', () => {
  it('submits a receipt and updates the cache', async () => {
    const receiptResponse: ReceiptResponsePayload = {
      deviceId: 'existing-device-id',
      platformReceiptId: 'receipt-123',
      entitlements: [
        { tier: 'free', grantedAt: '2024-01-01T00:00:00Z' },
        { tier: 'time_pass', grantedAt: '2024-01-15T10:00:00Z', expiresAt: '2024-01-16T10:00:00Z' },
      ],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client, storage } = createTestClient({
      deviceId: 'existing-device-id',
      fetchResponses: {
        '/v1/entitlements/receipt': {
          status: 200,
          body: jsonBytes(makeEnvelope(receiptResponse)),
        },
      },
    });

    const result = await client.submitReceipt('receipt-123', 'raw-receipt-data');
    expect(result.deviceId).toBe('existing-device-id');
    expect(result.fromCache).toBe(false);
    expect(result.entitlements).toHaveLength(2);
    expect(storage.savedCache).not.toBeNull();
  });

  it('sends correct JSON body to the backend', async () => {
    let capturedBody = '';
    const mockFetch: FetchImpl = async (_url, init) => {
      if (init.body) {
        capturedBody = typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body as Uint8Array);
      }
      const resp: ReceiptResponsePayload = {
        deviceId: 'dev-1',
        platformReceiptId: 'rcpt-1',
        entitlements: [],
        expiryUtc: '2024-01-20T00:00:00Z',
      };
      const body = jsonBytes(makeEnvelope(resp));
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async (): Promise<ArrayBuffer> => {
          const copy = new ArrayBuffer(body.byteLength);
          new Uint8Array(copy).set(body);
          return copy;
        },
      };
    };

    const http = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: mockFetch,
    });

    const storage = makeStorage({ deviceId: 'dev-1' });
    const client = createEntitlementClient({
      baseUrl: 'https://tramio.app',
      http,
      storage,
      now: () => 1705312800,
    });

    await client.submitReceipt('rcpt-1', 'apple-receipt-blob');
    const parsed = JSON.parse(capturedBody);
    expect(parsed.deviceId).toBe('dev-1');
    expect(parsed.platformReceiptId).toBe('rcpt-1');
    expect(parsed.platformReceipt).toBe('apple-receipt-blob');
  });

  it('throws EntitlementHttpError on non-200 response', async () => {
    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      fetchResponses: {
        '/v1/entitlements/receipt': { status: 400, body: jsonBytes({ error: 'invalid_receipt' }) },
      },
    });

    await expect(client.submitReceipt('bad', 'bad')).rejects.toThrow(EntitlementHttpError);
  });
});

// ---------------------------------------------------------------------------
// restorePurchases()
// ---------------------------------------------------------------------------

describe('EntitlementClient.restorePurchases', () => {
  it('restores purchases and updates the cache', async () => {
    const restoreResponse: RestoreResponsePayload = {
      deviceId: 'existing-device-id',
      entitlements: [
        { tier: 'free', grantedAt: '2024-01-01T00:00:00Z' },
        { tier: 'token_unlock', grantedAt: '2024-01-10T00:00:00Z' },
      ],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client, storage } = createTestClient({
      deviceId: 'existing-device-id',
      fetchResponses: {
        '/v1/entitlements/restore': {
          status: 200,
          body: jsonBytes(makeEnvelope(restoreResponse)),
        },
      },
    });

    const result = await client.restorePurchases([
      { platformReceiptId: 'rcpt-1', platformReceipt: 'data-1' },
      { platformReceiptId: 'rcpt-2', platformReceipt: 'data-2' },
    ]);

    expect(result.deviceId).toBe('existing-device-id');
    expect(result.fromCache).toBe(false);
    expect(result.entitlements).toHaveLength(2);
    expect(storage.savedCache).not.toBeNull();
  });

  it('throws EntitlementHttpError on non-200 response', async () => {
    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      fetchResponses: {
        '/v1/entitlements/restore': { status: 400, body: jsonBytes({ error: 'invalid_restore' }) },
      },
    });

    await expect(client.restorePurchases([])).rejects.toThrow(EntitlementHttpError);
  });
});

// ---------------------------------------------------------------------------
// getCachedEntitlements()
// ---------------------------------------------------------------------------

describe('EntitlementClient.getCachedEntitlements', () => {
  it('returns null when no cache exists', async () => {
    const { client } = createTestClient({
      deviceId: 'existing-device-id',
    });

    const result = await client.getCachedEntitlements();
    expect(result).toBeNull();
  });

  it('returns null when cache is expired', async () => {
    const expiredPayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00Z' }],
      expiryUtc: '2024-01-10T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(expiredPayload),
        expiryUtcSeconds: 1704844800, // 2024-01-10 (before now=2024-01-15)
        fetchedAtUtcSeconds: 1704758400,
      },
    });

    const result = await client.getCachedEntitlements();
    expect(result).toBeNull();
  });

  it('returns valid cached entitlements', async () => {
    const validPayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [
        { tier: 'free', grantedAt: '2024-01-01T00:00:00Z' },
        { tier: 'time_pass', grantedAt: '2024-01-14T00:00:00Z', expiresAt: '2024-01-16T00:00:00Z' },
      ],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(validPayload),
        expiryUtcSeconds: 1705708800, // 2024-01-20 (after now=2024-01-15)
        fetchedAtUtcSeconds: 1705312800,
      },
    });

    const result = await client.getCachedEntitlements();
    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(true);
    expect(result!.entitlements).toHaveLength(2);
  });

  it('filters expired individual entitlements from cache', async () => {
    const payload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [
        { tier: 'free', grantedAt: '2024-01-01T00:00:00Z' },
        // Expired before now (1705312800 = 2024-01-15T10:00:00Z)
        { tier: 'time_pass', grantedAt: '2024-01-10T00:00:00Z', expiresAt: '2024-01-12T00:00:00Z' },
      ],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(payload),
        expiryUtcSeconds: 1705708800,
        fetchedAtUtcSeconds: 1705312800,
      },
    });

    const result = await client.getCachedEntitlements();
    expect(result).not.toBeNull();
    // Only the 'free' entitlement should remain (time_pass expired)
    expect(result!.entitlements).toHaveLength(1);
    expect(result!.entitlements[0]!.tier).toBe('free');
  });
});

// ---------------------------------------------------------------------------
// Tour-active behavior (Req 3.2)
// ---------------------------------------------------------------------------

describe('EntitlementClient - tour-active behavior', () => {
  it('reads from cache during active tour (network blocked)', async () => {
    const validPayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00Z' }],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      tourActive: true,
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(validPayload),
        expiryUtcSeconds: 1705708800,
        fetchedAtUtcSeconds: 1705312800,
      },
    });

    // Should succeed from cache even though tour is active.
    const result = await client.resolveEntitlements();
    expect(result.fromCache).toBe(true);
    expect(result.entitlements).toHaveLength(1);
  });

  it('throws TourActiveBlockError when tour is active and no valid cache', async () => {
    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      tourActive: true,
      // No cache, so it must try network (which is blocked).
    });

    await expect(client.resolveEntitlements()).rejects.toThrow(TourActiveBlockError);
  });

  it('getCachedEntitlements works during active tour', async () => {
    const validPayload: EntitlementsPayload = {
      deviceId: 'existing-device-id',
      entitlements: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00Z' }],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'existing-device-id',
      tourActive: true,
      cached: {
        deviceId: 'existing-device-id',
        payload: JSON.stringify(validPayload),
        expiryUtcSeconds: 1705708800,
        fetchedAtUtcSeconds: 1705312800,
      },
    });

    const result = await client.getCachedEntitlements();
    expect(result).not.toBeNull();
    expect(result!.fromCache).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No email/phone/social required (Req 13.6)
// ---------------------------------------------------------------------------

describe('EntitlementClient - no signup required', () => {
  it('resolves entitlements using only Device_Id (no auth credentials)', async () => {
    const payload: EntitlementsPayload = {
      deviceId: 'anon-device-001',
      entitlements: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00Z' }],
      expiryUtc: '2024-01-20T00:00:00Z',
    };

    const { client } = createTestClient({
      deviceId: 'anon-device-001',
      fetchResponses: {
        '/v1/entitlements': {
          status: 200,
          body: jsonBytes(makeEnvelope(payload)),
        },
      },
    });

    // The client never asks for email/phone/social — it only uses Device_Id.
    const result = await client.resolveEntitlements();
    expect(result.deviceId).toBe('anon-device-001');
    expect(result.entitlements).toHaveLength(1);
  });
});
