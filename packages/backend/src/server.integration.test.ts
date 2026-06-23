/**
 * Integration tests for the Tramio backend stubs.
 *
 * Spins up Fastify in-process via `buildServer()` and verifies:
 *   - Each endpoint contract (status codes, payload shapes, error paths)
 *   - Ed25519 signature verification against the server's public key
 *   - Range request support for asset endpoints
 *   - Idempotency of receipt validation
 *   - Moderation segment disabling
 *
 * Requirements: 3.6, 13.2, 13.4, 13.5, 14.6, 18.1, 20.3
 */
import { buildServer } from './server';
import { createBackendStore } from './store';
import { createKeyRegistry } from './keys';
import {
  verifyPayload,
  verifyBytes,
  canonicalJsonStringify,
  importPublicKeySpkiB64Url,
} from './signing';
import type {
  CatalogListPayload,
  EntitlementsPayload,
  GtfsLatestPayload,
  ManifestLockPayload,
  ModerationPayload,
  ReceiptResponsePayload,
  RestoreResponsePayload,
} from './types';
import type { SignedEnvelope } from './envelope';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Shared test harness
// ---------------------------------------------------------------------------

const ASSET_CONTENT = Buffer.from('Hello, Tramio integration test asset!');

function buildHarness() {
  const keys = createKeyRegistry();
  const manifest: ManifestLockPayload = {
    bundleId: 'wroclaw-tram-7',
    version: '2.1.0',
    createdAt: '2024-06-15T12:00:00.000Z',
    assets: [
      { path: 'route.json', sizeBytes: 128, sha256: 'c'.repeat(64) },
      { path: 'narratives/poi-rynek.en.md', sizeBytes: ASSET_CONTENT.length, sha256: 'd'.repeat(64) },
    ],
  };
  const store = createBackendStore({
    bundles: [
      { bundleId: 'wroclaw-tram-7', version: '2.1.0', sizeBytes: 2048, requiredAppVersion: '1.0.0' },
      { bundleId: 'wroclaw-tram-7', version: '1.0.0', sizeBytes: 1024, requiredAppVersion: '0.9.0' },
    ],
    manifests: [manifest],
    assets: [
      { bundleId: 'wroclaw-tram-7', version: '2.1.0', path: 'narratives/poi-rynek.en.md', bytes: ASSET_CONTENT },
    ],
    gtfs: [
      {
        cityId: 'wroclaw',
        feedVersion: '2024-06-01',
        downloadUrl: 'https://gtfs.tramio.app/wroclaw/2024-06-01.zip',
        sha256: 'e'.repeat(64),
        publishedAt: '2024-06-01T00:00:00.000Z',
      },
    ],
    entitlementsByDevice: {
      'device-001': [
        { tier: 'free', grantedAt: '2024-01-01T00:00:00.000Z' },
        { tier: 'time_pass', grantedAt: '2024-06-01T00:00:00.000Z', expiresAt: '2099-12-31T23:59:59.000Z' },
      ],
    },
    disabledSegmentIds: ['poi-b2b-cafe', 'poi-b2b-shop'],
    defaultEntitlementExpiry: '2099-01-01T00:00:00.000Z',
  });
  const server = buildServer({ store, keys });
  return { server, keys, store, manifest };
}

// ---------------------------------------------------------------------------
// GET /v1/catalog
// ---------------------------------------------------------------------------

describe('GET /v1/catalog', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('returns 200 with a signed catalog listing', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/catalog' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<CatalogListPayload>;
    expect(body.payload.bundles).toHaveLength(2);
    expect(body.payload.fetchedAt).toBeDefined();
  });

  it('signature verifies against the catalog public key', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/catalog' });
    const body = res.json() as SignedEnvelope<CatalogListPayload>;
    const catKey = keys.getActive('cat');
    expect(verifyPayload(catKey.publicKey, body.payload, body.signature)).toBe(true);
  });

  it('signature verifies using the exported SPKI public key (client-side pinning)', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/catalog' });
    const body = res.json() as SignedEnvelope<CatalogListPayload>;
    const pubSet = keys.getPublicKeySet();
    const catDesc = pubSet.find((d) => d.kid === body.kid)!;
    const importedKey = importPublicKeySpkiB64Url(catDesc.publicKeySpkiB64Url);
    expect(verifyPayload(importedKey, body.payload, body.signature)).toBe(true);
  });

  it('kid matches the catalog key class', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/catalog' });
    const body = res.json() as SignedEnvelope<CatalogListPayload>;
    expect(body.kid).toBe('cat-001');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/catalog/:bundleId/:version/manifest.lock.json
// ---------------------------------------------------------------------------

describe('GET /v1/catalog/:bundleId/:version/manifest.lock.json', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('returns 200 with a signed manifest for a known bundle', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/manifest.lock.json',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<ManifestLockPayload>;
    expect(body.payload.bundleId).toBe('wroclaw-tram-7');
    expect(body.payload.version).toBe('2.1.0');
    expect(body.payload.assets).toHaveLength(2);
  });

  it('signature verifies against the catalog public key', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/manifest.lock.json',
    });
    const body = res.json() as SignedEnvelope<ManifestLockPayload>;
    const catKey = keys.getActive('cat');
    expect(verifyPayload(catKey.publicKey, body.payload, body.signature)).toBe(true);
  });

  it('returns 404 for an unknown bundle', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/nonexistent/0.0.1/manifest.lock.json',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'manifest_not_found' });
  });

  it('returns 404 for a known bundle but unknown version', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/9.9.9/manifest.lock.json',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/catalog/:bundleId/:version/manifest.lock.sig
// ---------------------------------------------------------------------------

describe('GET /v1/catalog/:bundleId/:version/manifest.lock.sig', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;
  let manifest: ManifestLockPayload;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
    manifest = h.manifest;
  });
  afterAll(() => server.close());

  it('returns a detached signature that verifies against the canonical manifest bytes', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/manifest.lock.sig',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { signature: string; kid: string };
    expect(body.kid).toBe('cat-001');
    const catKey = keys.getActive('cat');
    const canonical = Buffer.from(canonicalJsonStringify(manifest), 'utf8');
    expect(verifyBytes(catKey.publicKey, canonical, body.signature)).toBe(true);
  });

  it('returns 404 for an unknown bundle', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/unknown/1.0.0/manifest.lock.sig',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/catalog/:bundleId/:version/asset/* (range support)
// ---------------------------------------------------------------------------

describe('GET /v1/catalog/:bundleId/:version/asset/*', () => {
  let server: FastifyInstance;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
  });
  afterAll(() => server.close());

  it('returns 200 with full content when no Range header is present', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/asset/narratives/poi-rynek.en.md',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(ASSET_CONTENT.length));
    expect(res.rawPayload).toEqual(ASSET_CONTENT);
  });

  it('returns 206 with correct slice for a byte range request', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/asset/narratives/poi-rynek.en.md',
      headers: { range: 'bytes=0-4' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-4/${ASSET_CONTENT.length}`);
    expect(res.headers['content-length']).toBe('5');
    expect(res.rawPayload.toString('utf8')).toBe('Hello');
  });

  it('returns 206 for a suffix range request (last 5 bytes)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/asset/narratives/poi-rynek.en.md',
      headers: { range: 'bytes=-5' },
    });
    expect(res.statusCode).toBe(206);
    const expected = ASSET_CONTENT.subarray(ASSET_CONTENT.length - 5).toString('utf8');
    expect(res.rawPayload.toString('utf8')).toBe(expected);
  });

  it('returns 206 for an open-ended range (bytes=10-)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/asset/narratives/poi-rynek.en.md',
      headers: { range: 'bytes=10-' },
    });
    expect(res.statusCode).toBe(206);
    const expectedSlice = ASSET_CONTENT.subarray(10);
    expect(res.rawPayload).toEqual(expectedSlice);
    expect(res.headers['content-range']).toBe(
      `bytes 10-${ASSET_CONTENT.length - 1}/${ASSET_CONTENT.length}`,
    );
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/asset/narratives/poi-rynek.en.md',
      headers: { range: 'bytes=9999-' },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${ASSET_CONTENT.length}`);
  });

  it('includes X-Manifest-Lock-Sig-Url header pointing to the detached sig', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/asset/narratives/poi-rynek.en.md',
    });
    expect(res.headers['x-manifest-lock-sig-url']).toBe(
      '/v1/catalog/wroclaw-tram-7/2.1.0/manifest.lock.sig',
    );
  });

  it('returns 404 for a non-existent asset path', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/wroclaw-tram-7/2.1.0/asset/does-not-exist.bin',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'asset_not_found' });
  });

  it('returns 404 for a non-existent bundle in asset path', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/catalog/unknown/1.0.0/asset/file.bin',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/gtfs/:cityId/latest
// ---------------------------------------------------------------------------

describe('GET /v1/gtfs/:cityId/latest', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('returns 200 with a signed GTFS metadata payload for a known city', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/gtfs/wroclaw/latest' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<GtfsLatestPayload>;
    expect(body.payload.cityId).toBe('wroclaw');
    expect(body.payload.feedVersion).toBe('2024-06-01');
    expect(body.payload.downloadUrl).toMatch(/^https:\/\//);
    expect(body.payload.sha256).toHaveLength(64);
    expect(body.payload.publishedAt).toBeDefined();
  });

  it('signature verifies against the catalog public key', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/gtfs/wroclaw/latest' });
    const body = res.json() as SignedEnvelope<GtfsLatestPayload>;
    const catKey = keys.getActive('cat');
    expect(verifyPayload(catKey.publicKey, body.payload, body.signature)).toBe(true);
  });

  it('returns 404 for an unknown city', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/gtfs/unknown-city/latest' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'gtfs_not_found' });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/entitlements
// ---------------------------------------------------------------------------

describe('GET /v1/entitlements', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('returns 200 with a signed entitlement set for a known device', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/entitlements?deviceId=device-001',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<EntitlementsPayload>;
    expect(body.payload.deviceId).toBe('device-001');
    expect(body.payload.entitlements.length).toBeGreaterThanOrEqual(2);
    expect(body.payload.expiryUtc).toBeDefined();
  });

  it('signature verifies against the entitlement public key', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/entitlements?deviceId=device-001',
    });
    const body = res.json() as SignedEnvelope<EntitlementsPayload>;
    const entKey = keys.getActive('ent');
    expect(verifyPayload(entKey.publicKey, body.payload, body.signature)).toBe(true);
  });

  it('uses ent-001 kid (entitlement key class)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/entitlements?deviceId=device-001',
    });
    const body = res.json() as SignedEnvelope<EntitlementsPayload>;
    expect(body.kid).toBe('ent-001');
  });

  it('returns 200 with empty entitlements for an unknown device', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/entitlements?deviceId=device-unknown',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<EntitlementsPayload>;
    expect(body.payload.deviceId).toBe('device-unknown');
    expect(body.payload.entitlements).toEqual([]);
  });

  it('returns 400 when deviceId is missing', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/entitlements' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'device_id_required' });
  });

  it('accepts deviceId from X-Device-Id header', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/entitlements',
      headers: { 'x-device-id': 'device-001' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<EntitlementsPayload>;
    expect(body.payload.deviceId).toBe('device-001');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/entitlements/receipt
// ---------------------------------------------------------------------------

describe('POST /v1/entitlements/receipt', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('grants a time_pass entitlement on valid receipt', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId: 'device-new',
        platformReceiptId: 'receipt-001',
        platformReceipt: 'opaque-platform-data',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<ReceiptResponsePayload>;
    expect(body.payload.deviceId).toBe('device-new');
    expect(body.payload.platformReceiptId).toBe('receipt-001');
    expect(body.payload.entitlements.some((e) => e.tier === 'time_pass')).toBe(true);
    expect(body.payload.expiryUtc).toBeDefined();
  });

  it('signature verifies against the entitlement public key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId: 'device-sig-check',
        platformReceiptId: 'receipt-sig',
        platformReceipt: 'opaque',
      },
    });
    const body = res.json() as SignedEnvelope<ReceiptResponsePayload>;
    const entKey = keys.getActive('ent');
    expect(verifyPayload(entKey.publicKey, body.payload, body.signature)).toBe(true);
  });

  it('is idempotent on (deviceId, platformReceiptId)', async () => {
    // First call
    const res1 = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId: 'device-idem',
        platformReceiptId: 'receipt-idem',
        platformReceipt: 'blob-1',
      },
    });
    // Second call with same (deviceId, platformReceiptId)
    const res2 = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId: 'device-idem',
        platformReceiptId: 'receipt-idem',
        platformReceipt: 'blob-2-different',
      },
    });
    const body1 = res1.json() as SignedEnvelope<ReceiptResponsePayload>;
    const body2 = res2.json() as SignedEnvelope<ReceiptResponsePayload>;
    // Payloads should be identical (idempotent)
    expect(body1.payload.entitlements).toEqual(body2.payload.entitlements);
    expect(body1.payload.expiryUtc).toEqual(body2.payload.expiryUtc);
  });

  it('returns 400 when deviceId is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: { platformReceiptId: 'r', platformReceipt: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_receipt' });
  });

  it('returns 400 when platformReceiptId is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: { deviceId: 'd', platformReceipt: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when platformReceipt is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: { deviceId: 'd', platformReceiptId: 'r' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/entitlements/restore
// ---------------------------------------------------------------------------

describe('POST /v1/entitlements/restore', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('restores previously recorded receipts and returns signed entitlements', async () => {
    // Record a receipt first
    await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId: 'device-restore-int',
        platformReceiptId: 'rid-restore-1',
        platformReceipt: 'opaque',
      },
    });
    // Now restore
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/restore',
      payload: {
        deviceId: 'device-restore-int',
        receipts: [{ platformReceiptId: 'rid-restore-1', platformReceipt: 'opaque' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<RestoreResponsePayload>;
    expect(body.payload.deviceId).toBe('device-restore-int');
    expect(body.payload.entitlements.some((e) => e.tier === 'time_pass')).toBe(true);
  });

  it('signature verifies against the entitlement public key', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/restore',
      payload: {
        deviceId: 'device-restore-sig',
        receipts: [],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<RestoreResponsePayload>;
    const entKey = keys.getActive('ent');
    expect(verifyPayload(entKey.publicKey, body.payload, body.signature)).toBe(true);
  });

  it('returns empty entitlements when no receipts match', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/restore',
      payload: {
        deviceId: 'device-no-history',
        receipts: [{ platformReceiptId: 'nonexistent', platformReceipt: 'x' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<RestoreResponsePayload>;
    expect(body.payload.entitlements).toEqual([]);
  });

  it('returns 400 when deviceId is missing', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/restore',
      payload: { receipts: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_restore' });
  });

  it('returns 400 when receipts is not an array', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/restore',
      payload: { deviceId: 'd', receipts: 'not-array' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/moderation
// ---------------------------------------------------------------------------

describe('GET /v1/moderation', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('returns 200 with a signed disabled-segment list', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/moderation' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<ModerationPayload>;
    expect(body.payload.disabledSegmentIds).toEqual(['poi-b2b-cafe', 'poi-b2b-shop']);
    expect(body.payload.fetchedAt).toBeDefined();
  });

  it('signature verifies against the catalog public key', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/moderation' });
    const body = res.json() as SignedEnvelope<ModerationPayload>;
    const catKey = keys.getActive('cat');
    expect(verifyPayload(catKey.publicKey, body.payload, body.signature)).toBe(true);
  });

  it('kid matches the catalog key class', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/moderation' });
    const body = res.json() as SignedEnvelope<ModerationPayload>;
    expect(body.kid).toBe('cat-001');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: signature tamper detection
// ---------------------------------------------------------------------------

describe('Signature tamper detection', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('catalog signature does NOT verify against the entitlement key', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/catalog' });
    const body = res.json() as SignedEnvelope<CatalogListPayload>;
    const entKey = keys.getActive('ent');
    // Using the wrong key class should fail verification
    expect(verifyPayload(entKey.publicKey, body.payload, body.signature)).toBe(false);
  });

  it('entitlement signature does NOT verify against the catalog key', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/v1/entitlements?deviceId=device-001',
    });
    const body = res.json() as SignedEnvelope<EntitlementsPayload>;
    const catKey = keys.getActive('cat');
    expect(verifyPayload(catKey.publicKey, body.payload, body.signature)).toBe(false);
  });

  it('tampered payload fails signature verification', async () => {
    const res = await server.inject({ method: 'GET', url: '/v1/catalog' });
    const body = res.json() as SignedEnvelope<CatalogListPayload>;
    // Tamper with the payload
    const tampered = { ...body.payload, bundles: [] };
    const catKey = keys.getActive('cat');
    expect(verifyPayload(catKey.publicKey, tampered, body.signature)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: receipt → entitlements flow (Req 13.4, 13.5)
// ---------------------------------------------------------------------------

describe('Receipt → entitlements end-to-end flow', () => {
  let server: FastifyInstance;
  let keys: ReturnType<typeof createKeyRegistry>;

  beforeAll(() => {
    const h = buildHarness();
    server = h.server;
    keys = h.keys;
  });
  afterAll(() => server.close());

  it('a receipt grant is visible in subsequent GET /v1/entitlements', async () => {
    const deviceId = 'device-flow-test';
    // Initially no entitlements
    const before = await server.inject({
      method: 'GET',
      url: `/v1/entitlements?deviceId=${deviceId}`,
    });
    const beforeBody = before.json() as SignedEnvelope<EntitlementsPayload>;
    expect(beforeBody.payload.entitlements).toEqual([]);

    // Submit a receipt
    await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId,
        platformReceiptId: 'flow-receipt-1',
        platformReceipt: 'opaque',
      },
    });

    // Now entitlements should include the grant
    const after = await server.inject({
      method: 'GET',
      url: `/v1/entitlements?deviceId=${deviceId}`,
    });
    const afterBody = after.json() as SignedEnvelope<EntitlementsPayload>;
    expect(afterBody.payload.entitlements.some((e) => e.tier === 'time_pass')).toBe(true);
    // Signature still valid
    const entKey = keys.getActive('ent');
    expect(verifyPayload(entKey.publicKey, afterBody.payload, afterBody.signature)).toBe(true);
  });
});
