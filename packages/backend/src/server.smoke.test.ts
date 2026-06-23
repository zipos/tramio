/**
 * Smoke tests for the backend API surface.
 *
 * One positive case per endpoint, focused on response shape + signature
 * presence. Full integration coverage (signature verification with the
 * pinned client public key, asset SHA-256 round-trips, error paths) lands
 * under task 6.7.
 */
import { buildServer } from './server';
import { createBackendStore } from './store';
import { createKeyRegistry } from './keys';
import { verifyPayload, verifyBytes, canonicalJsonStringify } from './signing';
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

function buildHarness() {
  const keys = createKeyRegistry();
  const manifest: ManifestLockPayload = {
    bundleId: 'demo',
    version: '1.0.0',
    createdAt: '2024-01-01T00:00:00.000Z',
    assets: [
      {
        path: 'manifest.json',
        sizeBytes: 4,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  const store = createBackendStore({
    bundles: [
      {
        bundleId: 'demo',
        version: '1.0.0',
        sizeBytes: 4,
        requiredAppVersion: '0.1.0',
      },
    ],
    manifests: [manifest],
    assets: [
      {
        bundleId: 'demo',
        version: '1.0.0',
        path: 'manifest.json',
        bytes: Buffer.from('AAAA'),
      },
    ],
    gtfs: [
      {
        cityId: 'krk',
        feedVersion: '2024-05-01',
        downloadUrl: 'https://example.test/gtfs/krk-2024-05-01.zip',
        sha256: 'b'.repeat(64),
        publishedAt: '2024-05-01T00:00:00.000Z',
      },
    ],
    entitlementsByDevice: {
      'device-abc': [{ tier: 'free', grantedAt: '2024-01-01T00:00:00.000Z' }],
    },
    disabledSegmentIds: ['poi-42'],
    defaultEntitlementExpiry: '2099-01-01T00:00:00.000Z',
  });
  const server = buildServer({ store, keys });
  return { server, keys, store, manifest };
}

afterEach(async () => {
  // Each test builds its own server, but Fastify hangs on to file handles
  // until `.close()` resolves; the inject API does not start a listener.
});

describe('buildServer smoke tests', () => {
  test('GET /v1/catalog returns a signed bundle list', async () => {
    const { server, keys } = buildHarness();
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/catalog' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SignedEnvelope<CatalogListPayload>;
      expect(body.kid).toBe('cat-001');
      expect(body.signature).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(body.payload.bundles).toHaveLength(1);
      expect(body.payload.bundles[0]?.bundleId).toBe('demo');
      const cat = keys.getActive('cat');
      expect(verifyPayload(cat.publicKey, body.payload, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('GET /v1/catalog/:bundle/:version/manifest.lock.json returns a signed manifest', async () => {
    const { server, keys } = buildHarness();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/v1/catalog/demo/1.0.0/manifest.lock.json',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SignedEnvelope<ManifestLockPayload>;
      expect(body.kid).toBe('cat-001');
      expect(body.payload.bundleId).toBe('demo');
      expect(body.payload.version).toBe('1.0.0');
      const cat = keys.getActive('cat');
      expect(verifyPayload(cat.publicKey, body.payload, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('GET /v1/catalog/:bundle/:version/manifest.lock.sig verifies against the live manifest', async () => {
    const { server, keys, manifest } = buildHarness();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/v1/catalog/demo/1.0.0/manifest.lock.sig',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { signature: string; kid: string };
      expect(body.kid).toBe('cat-001');
      const cat = keys.getActive('cat');
      const canonical = Buffer.from(canonicalJsonStringify(manifest), 'utf8');
      expect(verifyBytes(cat.publicKey, canonical, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('GET /v1/catalog/.../asset/* honors a Range request and returns 206', async () => {
    const { server } = buildHarness();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/v1/catalog/demo/1.0.0/asset/manifest.json',
        headers: { range: 'bytes=1-2' },
      });
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-range']).toBe('bytes 1-2/4');
      expect(res.headers['content-length']).toBe('2');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['x-manifest-lock-sig-url']).toBe(
        '/v1/catalog/demo/1.0.0/manifest.lock.sig',
      );
      expect(res.rawPayload.toString('utf8')).toBe('AA');
    } finally {
      await server.close();
    }
  });

  test('GET /v1/gtfs/:cityId/latest returns a signed GTFS metadata payload', async () => {
    const { server, keys } = buildHarness();
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/gtfs/krk/latest' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SignedEnvelope<GtfsLatestPayload>;
      expect(body.kid).toBe('cat-001');
      expect(body.payload.cityId).toBe('krk');
      expect(body.payload.downloadUrl).toMatch(/^https:\/\//);
      const cat = keys.getActive('cat');
      expect(verifyPayload(cat.publicKey, body.payload, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('GET /v1/entitlements returns a signed entitlement set', async () => {
    const { server, keys } = buildHarness();
    try {
      const res = await server.inject({
        method: 'GET',
        url: '/v1/entitlements?deviceId=device-abc',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SignedEnvelope<EntitlementsPayload>;
      expect(body.kid).toBe('ent-001');
      expect(body.payload.deviceId).toBe('device-abc');
      expect(body.payload.entitlements.length).toBeGreaterThan(0);
      const ent = keys.getActive('ent');
      expect(verifyPayload(ent.publicKey, body.payload, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('POST /v1/entitlements/receipt grants a signed time-pass entitlement', async () => {
    const { server, keys } = buildHarness();
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: {
          deviceId: 'device-xyz',
          platformReceiptId: 'rid-1',
          platformReceipt: 'opaque-platform-blob',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SignedEnvelope<ReceiptResponsePayload>;
      expect(body.kid).toBe('ent-001');
      expect(body.payload.deviceId).toBe('device-xyz');
      expect(body.payload.platformReceiptId).toBe('rid-1');
      expect(body.payload.entitlements.some((e) => e.tier === 'time_pass')).toBe(true);
      const ent = keys.getActive('ent');
      expect(verifyPayload(ent.publicKey, body.payload, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('POST /v1/entitlements/restore replays previously recorded receipts', async () => {
    const { server, keys } = buildHarness();
    try {
      // First record a receipt so restore has something to find.
      await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: {
          deviceId: 'device-restore',
          platformReceiptId: 'rid-restore',
          platformReceipt: 'opaque',
        },
      });
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/restore',
        payload: {
          deviceId: 'device-restore',
          receipts: [{ platformReceiptId: 'rid-restore', platformReceipt: 'opaque' }],
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SignedEnvelope<RestoreResponsePayload>;
      expect(body.kid).toBe('ent-001');
      expect(body.payload.deviceId).toBe('device-restore');
      expect(body.payload.entitlements.some((e) => e.tier === 'time_pass')).toBe(true);
      const ent = keys.getActive('ent');
      expect(verifyPayload(ent.publicKey, body.payload, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });

  test('GET /v1/moderation returns a signed disabled-segment list', async () => {
    const { server, keys } = buildHarness();
    try {
      const res = await server.inject({ method: 'GET', url: '/v1/moderation' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as SignedEnvelope<ModerationPayload>;
      expect(body.kid).toBe('cat-001');
      expect(body.payload.disabledSegmentIds).toEqual(['poi-42']);
      const cat = keys.getActive('cat');
      expect(verifyPayload(cat.publicKey, body.payload, body.signature)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
