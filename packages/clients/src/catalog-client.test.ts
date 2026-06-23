import {
  createCatalogClient,
  CatalogHttpError,
  type CatalogStorageProvider,
  type CatalogListPayload,
  type ManifestLockPayload,
  type ModerationPayload,
  type SignedEnvelope,
} from './catalog-client';
import {
  createHttpClient,
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

function makeStorage(
  installed: Array<{ bundleId: string; version: string }> = [],
): CatalogStorageProvider & { savedModeration: ModerationPayload | null } {
  const store = {
    savedModeration: null as ModerationPayload | null,
    async getInstalledPacks() {
      return installed;
    },
    async saveModerationSnapshot(payload: ModerationPayload) {
      store.savedModeration = payload;
    },
    async getModerationSnapshot() {
      return store.savedModeration;
    },
  };
  return store;
}

function makeEnvelope<T>(payload: T): SignedEnvelope<T> {
  return { payload, signature: 'fake-sig', kid: 'test-kid' };
}

function jsonBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Creates a mock fetch that responds based on URL patterns.
 */
function makeFetch(
  responses: Record<string, { status: number; body: Uint8Array; headers?: Record<string, string | null> }>,
): FetchImpl {
  return async (url, _init) => {
    // Find matching response by checking if the URL starts with any key.
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
  installed?: Array<{ bundleId: string; version: string }>;
}) {
  const {
    fetchResponses = {},
    tourActive = false,
    unmetered = true,
    installed = [],
  } = opts;

  const networkInfo = makeNetworkInfo(unmetered);
  const http = createHttpClient({
    tourState: makeTourState(tourActive),
    networkInfo,
    fetch: makeFetch(fetchResponses),
  });
  const storage = makeStorage(installed);

  const client = createCatalogClient({
    baseUrl: 'https://tramio.app',
    http,
    networkInfo,
    storage,
  });

  return { client, storage, networkInfo };
}

// ---------------------------------------------------------------------------
// probe()
// ---------------------------------------------------------------------------

describe('CatalogClient.probe', () => {
  const catalogPayload: CatalogListPayload = {
    bundles: [
      { bundleId: 'wroclaw-tram-7', version: '1.4.2', sizeBytes: 50_000_000, requiredAppVersion: '1.0.0' },
      { bundleId: 'wroclaw-tram-3', version: '2.0.0', sizeBytes: 30_000_000, requiredAppVersion: '1.0.0' },
    ],
    fetchedAt: '2025-01-15T10:00:00Z',
  };

  it('returns catalog listing from the backend', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/v1/catalog': {
          status: 200,
          body: jsonBytes(makeEnvelope(catalogPayload)),
        },
      },
    });

    const result = await client.probe();
    expect(result.catalog).toEqual(catalogPayload);
    expect(result.catalog.bundles).toHaveLength(2);
  });

  it('identifies updates available when installed version differs', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/v1/catalog': {
          status: 200,
          body: jsonBytes(makeEnvelope(catalogPayload)),
        },
      },
      installed: [{ bundleId: 'wroclaw-tram-7', version: '1.3.0' }],
    });

    const result = await client.probe();
    expect(result.updatesAvailable).toHaveLength(2);
    expect(result.updatesAvailable[0]).toEqual({
      bundleId: 'wroclaw-tram-7',
      currentVersion: '1.3.0',
      availableVersion: '1.4.2',
      sizeBytes: 50_000_000,
    });
    expect(result.updatesAvailable[1]).toEqual({
      bundleId: 'wroclaw-tram-3',
      currentVersion: null,
      availableVersion: '2.0.0',
      sizeBytes: 30_000_000,
    });
  });

  it('reports no updates when installed versions match', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/v1/catalog': {
          status: 200,
          body: jsonBytes(makeEnvelope(catalogPayload)),
        },
      },
      installed: [
        { bundleId: 'wroclaw-tram-7', version: '1.4.2' },
        { bundleId: 'wroclaw-tram-3', version: '2.0.0' },
      ],
    });

    const result = await client.probe();
    expect(result.updatesAvailable).toHaveLength(0);
    expect(result.meteredConnectionSuppressed).toBe(false);
  });

  it('sets meteredConnectionSuppressed when on metered and updates exist', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/v1/catalog': {
          status: 200,
          body: jsonBytes(makeEnvelope(catalogPayload)),
        },
      },
      unmetered: false,
      installed: [{ bundleId: 'wroclaw-tram-7', version: '1.3.0' }],
    });

    const result = await client.probe();
    expect(result.meteredConnectionSuppressed).toBe(true);
    expect(result.updatesAvailable.length).toBeGreaterThan(0);
  });

  it('does not set meteredConnectionSuppressed when on metered but no updates', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/v1/catalog': {
          status: 200,
          body: jsonBytes(makeEnvelope(catalogPayload)),
        },
      },
      unmetered: false,
      installed: [
        { bundleId: 'wroclaw-tram-7', version: '1.4.2' },
        { bundleId: 'wroclaw-tram-3', version: '2.0.0' },
      ],
    });

    const result = await client.probe();
    expect(result.meteredConnectionSuppressed).toBe(false);
  });

  it('throws CatalogHttpError on non-200 response', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/v1/catalog': { status: 500, body: jsonBytes({ error: 'internal' }) },
      },
    });

    await expect(client.probe()).rejects.toThrow(CatalogHttpError);
    await expect(client.probe()).rejects.toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// fetchManifestLock()
// ---------------------------------------------------------------------------

describe('CatalogClient.fetchManifestLock', () => {
  const lockPayload: ManifestLockPayload = {
    bundleId: 'wroclaw-tram-7',
    version: '1.4.2',
    assets: [
      { path: 'manifest.json', sizeBytes: 1024, sha256: 'abc123' },
      { path: 'route.json', sizeBytes: 2048, sha256: 'def456' },
    ],
    createdAt: '2025-01-15T10:00:00Z',
  };

  it('returns the signed manifest lock envelope', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        'manifest.lock.json': {
          status: 200,
          body: jsonBytes(makeEnvelope(lockPayload)),
        },
      },
    });

    const result = await client.fetchManifestLock('wroclaw-tram-7', '1.4.2');
    expect(result.payload).toEqual(lockPayload);
    expect(result.signature).toBe('fake-sig');
    expect(result.kid).toBe('test-kid');
  });

  it('throws CatalogHttpError on 404', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        'manifest.lock.json': { status: 404, body: jsonBytes({ error: 'not_found' }) },
      },
    });

    await expect(
      client.fetchManifestLock('nonexistent', '1.0.0'),
    ).rejects.toThrow(CatalogHttpError);
  });

  it('URL-encodes bundleId and version', async () => {
    let capturedUrl = '';
    const mockFetch: FetchImpl = async (url, _init) => {
      capturedUrl = url;
      const body = jsonBytes(makeEnvelope(lockPayload));
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

    const client = createCatalogClient({
      baseUrl: 'https://tramio.app',
      http,
      networkInfo: makeNetworkInfo(true),
      storage: makeStorage(),
    });

    await client.fetchManifestLock('bundle/with/slashes', '1.0.0+build');
    expect(capturedUrl).toContain('bundle%2Fwith%2Fslashes');
    expect(capturedUrl).toContain('1.0.0%2Bbuild');
  });
});

// ---------------------------------------------------------------------------
// fetchAsset()
// ---------------------------------------------------------------------------

describe('CatalogClient.fetchAsset', () => {
  const assetData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  it('fetches a full asset (200)', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/asset/': {
          status: 200,
          body: assetData,
          headers: {
            'content-length': '10',
          },
        },
      },
    });

    const result = await client.fetchAsset('bundle-1', '1.0.0', 'audio/test.m4a');
    expect(result.status).toBe(200);
    expect(result.data).toEqual(assetData);
    expect(result.totalBytes).toBe(10);
    expect(result.rangeStart).toBe(0);
    expect(result.rangeEnd).toBe(9);
  });

  it('fetches a ranged asset (206) with Content-Range header', async () => {
    const partialData = new Uint8Array([5, 6, 7, 8, 9, 10]);
    const { client } = createTestClient({
      fetchResponses: {
        '/asset/': {
          status: 206,
          body: partialData,
          headers: {
            'content-range': 'bytes 4-9/10',
            'content-length': '6',
          },
        },
      },
    });

    const result = await client.fetchAsset('bundle-1', '1.0.0', 'audio/test.m4a', {
      rangeStart: 4,
    });
    expect(result.status).toBe(206);
    expect(result.data).toEqual(partialData);
    expect(result.totalBytes).toBe(10);
    expect(result.rangeStart).toBe(4);
    expect(result.rangeEnd).toBe(9);
  });

  it('sends Range header when rangeStart is specified', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: FetchImpl = async (_url, init) => {
      capturedHeaders = init.headers;
      return {
        status: 206,
        headers: {
          get: (name: string) => {
            if (name === 'content-range') return 'bytes 100-199/500';
            if (name === 'content-length') return '100';
            return null;
          },
        },
        arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(100),
      };
    };

    const http = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: mockFetch,
    });

    const client = createCatalogClient({
      baseUrl: 'https://tramio.app',
      http,
      networkInfo: makeNetworkInfo(true),
      storage: makeStorage(),
    });

    await client.fetchAsset('bundle-1', '1.0.0', 'audio/test.m4a', {
      rangeStart: 100,
      rangeEnd: 199,
    });

    expect(capturedHeaders['Range']).toBe('bytes=100-199');
  });

  it('sends open-ended Range header when only rangeStart is specified', async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: FetchImpl = async (_url, init) => {
      capturedHeaders = init.headers;
      return {
        status: 206,
        headers: {
          get: (name: string) => {
            if (name === 'content-range') return 'bytes 50-99/100';
            if (name === 'content-length') return '50';
            return null;
          },
        },
        arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(50),
      };
    };

    const http = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: mockFetch,
    });

    const client = createCatalogClient({
      baseUrl: 'https://tramio.app',
      http,
      networkInfo: makeNetworkInfo(true),
      storage: makeStorage(),
    });

    await client.fetchAsset('bundle-1', '1.0.0', 'audio/test.m4a', {
      rangeStart: 50,
    });

    expect(capturedHeaders['Range']).toBe('bytes=50-');
  });

  it('uses intent "download" so metered policy applies', async () => {
    const { client } = createTestClient({
      fetchResponses: {},
      unmetered: false,
    });

    // Should throw MeteredConnectionBlockError from the HTTP wrapper.
    await expect(
      client.fetchAsset('bundle-1', '1.0.0', 'audio/test.m4a'),
    ).rejects.toThrow(/metered/i);
  });

  it('allows download on metered when allowMetered is true', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/asset/': {
          status: 200,
          body: assetData,
          headers: { 'content-length': '10' },
        },
      },
      unmetered: false,
    });

    const result = await client.fetchAsset('bundle-1', '1.0.0', 'audio/test.m4a', {
      allowMetered: true,
    });
    expect(result.status).toBe(200);
  });

  it('throws CatalogHttpError on 404', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/asset/': { status: 404, body: jsonBytes({ error: 'not_found' }) },
      },
    });

    await expect(
      client.fetchAsset('bundle-1', '1.0.0', 'nonexistent.m4a'),
    ).rejects.toThrow(CatalogHttpError);
  });
});

// ---------------------------------------------------------------------------
// refreshModeration()
// ---------------------------------------------------------------------------

describe('CatalogClient.refreshModeration', () => {
  const moderationPayload: ModerationPayload = {
    disabledSegmentIds: ['poi-cafe-zamek-b2b', 'poi-hotel-promo'],
    fetchedAt: '2025-01-15T12:00:00Z',
  };

  it('fetches and persists moderation state', async () => {
    const { client, storage } = createTestClient({
      fetchResponses: {
        '/v1/moderation': {
          status: 200,
          body: jsonBytes(makeEnvelope(moderationPayload)),
        },
      },
    });

    const result = await client.refreshModeration();
    expect(result).toEqual(moderationPayload);
    expect(storage.savedModeration).toEqual(moderationPayload);
  });

  it('throws CatalogHttpError on non-200 response', async () => {
    const { client } = createTestClient({
      fetchResponses: {
        '/v1/moderation': { status: 503, body: jsonBytes({ error: 'unavailable' }) },
      },
    });

    await expect(client.refreshModeration()).rejects.toThrow(CatalogHttpError);
  });
});

// ---------------------------------------------------------------------------
// getCachedModeration()
// ---------------------------------------------------------------------------

describe('CatalogClient.getCachedModeration', () => {
  it('returns null when no snapshot is cached', async () => {
    const { client } = createTestClient({});
    const result = await client.getCachedModeration();
    expect(result).toBeNull();
  });

  it('returns the cached snapshot after refreshModeration', async () => {
    const moderationPayload: ModerationPayload = {
      disabledSegmentIds: ['seg-1'],
      fetchedAt: '2025-01-15T12:00:00Z',
    };

    const { client } = createTestClient({
      fetchResponses: {
        '/v1/moderation': {
          status: 200,
          body: jsonBytes(makeEnvelope(moderationPayload)),
        },
      },
    });

    await client.refreshModeration();
    const cached = await client.getCachedModeration();
    expect(cached).toEqual(moderationPayload);
  });
});

// ---------------------------------------------------------------------------
// Integration: metered connection suppresses auto-download (Req 3.6)
// ---------------------------------------------------------------------------

describe('CatalogClient - metered connection behavior', () => {
  it('probe succeeds on metered (intent is probe, not download)', async () => {
    const catalogPayload: CatalogListPayload = {
      bundles: [
        { bundleId: 'b1', version: '1.0.0', sizeBytes: 1000, requiredAppVersion: '1.0.0' },
      ],
      fetchedAt: '2025-01-15T10:00:00Z',
    };

    const { client } = createTestClient({
      fetchResponses: {
        '/v1/catalog': {
          status: 200,
          body: jsonBytes(makeEnvelope(catalogPayload)),
        },
      },
      unmetered: false,
    });

    // Probe should work on metered — it's a lightweight check.
    const result = await client.probe();
    expect(result.catalog.bundles).toHaveLength(1);
  });

  it('refreshModeration succeeds on metered (intent is probe)', async () => {
    const moderationPayload: ModerationPayload = {
      disabledSegmentIds: [],
      fetchedAt: '2025-01-15T12:00:00Z',
    };

    const { client } = createTestClient({
      fetchResponses: {
        '/v1/moderation': {
          status: 200,
          body: jsonBytes(makeEnvelope(moderationPayload)),
        },
      },
      unmetered: false,
    });

    const result = await client.refreshModeration();
    expect(result.disabledSegmentIds).toHaveLength(0);
  });

  it('fetchManifestLock succeeds on metered (intent is probe)', async () => {
    const lockPayload: ManifestLockPayload = {
      bundleId: 'b1',
      version: '1.0.0',
      assets: [],
      createdAt: '2025-01-15T10:00:00Z',
    };

    const { client } = createTestClient({
      fetchResponses: {
        'manifest.lock.json': {
          status: 200,
          body: jsonBytes(makeEnvelope(lockPayload)),
        },
      },
      unmetered: false,
    });

    const result = await client.fetchManifestLock('b1', '1.0.0');
    expect(result.payload.bundleId).toBe('b1');
  });
});
