import {
  createHttpClient,
  isLoopbackOrIpc,
  TourActiveBlockError,
  MeteredConnectionBlockError,
  type FetchImpl,
  type NetworkInfoProvider,
  type TourStateProvider,
} from './http-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTourState(active: boolean): TourStateProvider {
  return { isTourActive: () => active };
}

function makeNetworkInfo(unmetered: boolean): NetworkInfoProvider {
  return { isUnmetered: () => unmetered };
}

function makeFetch(status = 200, body = new Uint8Array([])): FetchImpl {
  return async (_url, _init) => ({
    status,
    headers: { get: () => null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
}

// ---------------------------------------------------------------------------
// isLoopbackOrIpc
// ---------------------------------------------------------------------------

describe('isLoopbackOrIpc', () => {
  it('returns true for localhost', () => {
    expect(isLoopbackOrIpc('http://localhost:3000/v1/catalog')).toBe(true);
    expect(isLoopbackOrIpc('https://LOCALHOST/path')).toBe(true);
  });

  it('returns true for 127.x.x.x', () => {
    expect(isLoopbackOrIpc('http://127.0.0.1:8080/api')).toBe(true);
    expect(isLoopbackOrIpc('http://127.255.255.255/')).toBe(true);
  });

  it('returns true for [::1]', () => {
    expect(isLoopbackOrIpc('http://[::1]:3000/test')).toBe(true);
  });

  it('returns true for 0.0.0.0', () => {
    expect(isLoopbackOrIpc('http://0.0.0.0:5000/')).toBe(true);
  });

  it('returns true for 10.0.x.x emulator addresses', () => {
    expect(isLoopbackOrIpc('http://10.0.2.2:3000/')).toBe(true);
    expect(isLoopbackOrIpc('http://10.0.3.2/')).toBe(true);
  });

  it('returns false for external hosts', () => {
    expect(isLoopbackOrIpc('https://tramio.app/v1/catalog')).toBe(false);
    expect(isLoopbackOrIpc('https://api.example.com/')).toBe(false);
  });

  it('returns false for non-loopback private IPs', () => {
    expect(isLoopbackOrIpc('http://192.168.1.1/')).toBe(false);
    expect(isLoopbackOrIpc('http://10.1.0.1/')).toBe(false);
  });

  it('returns false for unparseable URLs', () => {
    expect(isLoopbackOrIpc('not-a-url')).toBe(false);
    expect(isLoopbackOrIpc('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tour-active guard (Req 3.2)
// ---------------------------------------------------------------------------

describe('createHttpClient - tour-active guard', () => {
  it('throws TourActiveBlockError for external URLs when tour is active', async () => {
    const client = createHttpClient({
      tourState: makeTourState(true),
      networkInfo: makeNetworkInfo(true),
      fetch: makeFetch(),
    });

    await expect(
      client.request({ url: 'https://tramio.app/v1/catalog' }),
    ).rejects.toThrow(TourActiveBlockError);
  });

  it('allows loopback requests when tour is active', async () => {
    const client = createHttpClient({
      tourState: makeTourState(true),
      networkInfo: makeNetworkInfo(true),
      fetch: makeFetch(200),
    });

    const response = await client.request({ url: 'http://localhost:3000/v1/catalog' });
    expect(response.status).toBe(200);
  });

  it('allows external requests when tour is NOT active', async () => {
    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: makeFetch(200),
    });

    const response = await client.request({ url: 'https://tramio.app/v1/catalog' });
    expect(response.status).toBe(200);
  });

  it('allows 127.0.0.1 requests when tour is active', async () => {
    const client = createHttpClient({
      tourState: makeTourState(true),
      networkInfo: makeNetworkInfo(true),
      fetch: makeFetch(200),
    });

    const response = await client.request({ url: 'http://127.0.0.1:8080/api' });
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Metered connection policy (Req 3.6, 18.2)
// ---------------------------------------------------------------------------

describe('createHttpClient - metered connection policy', () => {
  it('throws MeteredConnectionBlockError for downloads on metered connection', async () => {
    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(false), // metered
      fetch: makeFetch(),
    });

    await expect(
      client.request({
        url: 'https://tramio.app/v1/catalog/bundle/1.0/asset/audio.m4a',
        intent: 'download',
      }),
    ).rejects.toThrow(MeteredConnectionBlockError);
  });

  it('allows probes on metered connection', async () => {
    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(false), // metered
      fetch: makeFetch(200),
    });

    const response = await client.request({
      url: 'https://tramio.app/v1/catalog',
      intent: 'probe',
    });
    expect(response.status).toBe(200);
  });

  it('allows downloads on unmetered connection', async () => {
    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true), // unmetered
      fetch: makeFetch(200),
    });

    const response = await client.request({
      url: 'https://tramio.app/v1/catalog/bundle/1.0/asset/audio.m4a',
      intent: 'download',
    });
    expect(response.status).toBe(200);
  });

  it('allows downloads on metered connection when allowMetered is true', async () => {
    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(false), // metered
      fetch: makeFetch(200),
    });

    const response = await client.request({
      url: 'https://tramio.app/v1/catalog/bundle/1.0/asset/audio.m4a',
      intent: 'download',
      allowMetered: true,
    });
    expect(response.status).toBe(200);
  });

  it('defaults intent to probe when not specified', async () => {
    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(false), // metered
      fetch: makeFetch(200),
    });

    // Should succeed because default intent is 'probe'
    const response = await client.request({
      url: 'https://tramio.app/v1/catalog',
    });
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Request forwarding
// ---------------------------------------------------------------------------

describe('createHttpClient - request forwarding', () => {
  it('forwards method, headers, and body to the fetch implementation', async () => {
    let capturedUrl = '';
    let capturedInit: { method: string; headers: Record<string, string>; body?: unknown } | undefined;

    const mockFetch: FetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        status: 201,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: mockFetch,
    });

    await client.request({
      url: 'https://tramio.app/v1/entitlements/receipt',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'dev-123' },
      body: '{"deviceId":"dev-123"}',
    });

    expect(capturedUrl).toBe('https://tramio.app/v1/entitlements/receipt');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers['Content-Type']).toBe('application/json');
    expect(capturedInit?.headers['X-Device-Id']).toBe('dev-123');
    expect(capturedInit?.body).toBe('{"deviceId":"dev-123"}');
  });

  it('returns response status, headers, and body', async () => {
    const responseBody = new TextEncoder().encode('{"ok":true}');
    const mockFetch: FetchImpl = async () => ({
      status: 200,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json';
          if (name === 'content-length') return '11';
          return null;
        },
      },
      arrayBuffer: async () =>
        responseBody.buffer.slice(
          responseBody.byteOffset,
          responseBody.byteOffset + responseBody.byteLength,
        ),
    });

    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: mockFetch,
    });

    const response = await client.request({ url: 'https://tramio.app/v1/catalog' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.headers['content-length']).toBe('11');
    expect(new TextDecoder().decode(response.body)).toBe('{"ok":true}');
  });

  it('defaults method to GET', async () => {
    let capturedMethod = '';
    const mockFetch: FetchImpl = async (_url, init) => {
      capturedMethod = init.method;
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };

    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo: makeNetworkInfo(true),
      fetch: mockFetch,
    });

    await client.request({ url: 'https://tramio.app/v1/catalog' });
    expect(capturedMethod).toBe('GET');
  });
});

// ---------------------------------------------------------------------------
// Guard ordering: tour-active takes precedence over metered policy
// ---------------------------------------------------------------------------

describe('createHttpClient - guard ordering', () => {
  it('tour-active guard fires before metered policy', async () => {
    const client = createHttpClient({
      tourState: makeTourState(true),
      networkInfo: makeNetworkInfo(false), // metered
      fetch: makeFetch(),
    });

    // Even though this is a download on metered, the tour-active guard
    // should fire first with TourActiveBlockError.
    await expect(
      client.request({
        url: 'https://tramio.app/v1/catalog/bundle/1.0/asset/audio.m4a',
        intent: 'download',
      }),
    ).rejects.toThrow(TourActiveBlockError);
  });
});

// ---------------------------------------------------------------------------
// Dynamic state changes
// ---------------------------------------------------------------------------

describe('createHttpClient - dynamic state', () => {
  it('respects tour state changes between requests', async () => {
    let tourActive = false;
    const tourState: TourStateProvider = { isTourActive: () => tourActive };

    const client = createHttpClient({
      tourState,
      networkInfo: makeNetworkInfo(true),
      fetch: makeFetch(200),
    });

    // First request: tour not active, should succeed
    const r1 = await client.request({ url: 'https://tramio.app/v1/catalog' });
    expect(r1.status).toBe(200);

    // Tour starts
    tourActive = true;

    // Second request: tour active, should throw
    await expect(
      client.request({ url: 'https://tramio.app/v1/catalog' }),
    ).rejects.toThrow(TourActiveBlockError);

    // Tour ends
    tourActive = false;

    // Third request: tour not active again, should succeed
    const r3 = await client.request({ url: 'https://tramio.app/v1/catalog' });
    expect(r3.status).toBe(200);
  });

  it('respects network info changes between requests', async () => {
    let unmetered = true;
    const networkInfo: NetworkInfoProvider = { isUnmetered: () => unmetered };

    const client = createHttpClient({
      tourState: makeTourState(false),
      networkInfo,
      fetch: makeFetch(200),
    });

    // WiFi: download allowed
    const r1 = await client.request({
      url: 'https://tramio.app/asset',
      intent: 'download',
    });
    expect(r1.status).toBe(200);

    // Switch to cellular
    unmetered = false;

    // Cellular: download blocked
    await expect(
      client.request({ url: 'https://tramio.app/asset', intent: 'download' }),
    ).rejects.toThrow(MeteredConnectionBlockError);
  });
});
