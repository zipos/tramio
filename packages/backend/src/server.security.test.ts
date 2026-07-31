/**
 * Security-focused tests for the receipt/restore endpoint hardening.
 *
 * Covers:
 *   - Fail-closed: receipt rejected when verification is not configured
 *   - Replay protection: same receipt does not duplicate entitlements
 *   - Rate limiting: requests blocked after threshold
 *   - Input validation: malformed bodies return 4xx, never 500
 *   - Restore endpoint also gated by verification mode
 */
import { buildServer } from './server';
import { createBackendStore } from './store';
import { createKeyRegistry } from './keys';
import type { ReceiptResponsePayload } from './types';
import type { SignedEnvelope } from './envelope';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSecurityHarness(opts: {
  receiptMode?: 'stub' | 'reject';
  rateLimitMaxRequests?: number;
  rateLimitWindowMs?: number;
}) {
  const keys = createKeyRegistry();
  const store = createBackendStore({
    defaultEntitlementExpiry: '2099-01-01T00:00:00.000Z',
  });
  const server = buildServer({
    store,
    keys,
    ...(opts.receiptMode !== undefined ? { receiptMode: opts.receiptMode } : {}),
    ...(opts.rateLimitMaxRequests !== undefined
      ? { rateLimitMaxRequests: opts.rateLimitMaxRequests }
      : {}),
    ...(opts.rateLimitWindowMs !== undefined ? { rateLimitWindowMs: opts.rateLimitWindowMs } : {}),
  });
  return { server, keys, store };
}

const VALID_RECEIPT = {
  deviceId: 'device-sec-test',
  platformReceiptId: 'receipt-sec-001',
  platformReceipt: 'opaque-platform-data',
};

const VALID_RESTORE = {
  deviceId: 'device-sec-test',
  receipts: [{ platformReceiptId: 'receipt-sec-001', platformReceipt: 'opaque' }],
};

// ---------------------------------------------------------------------------
// 1. Fail-closed: receipt rejected when verification is not configured
// ---------------------------------------------------------------------------

describe('Receipt verification gate (fail-closed)', () => {
  let server: FastifyInstance;

  beforeAll(() => {
    // Default mode (no receiptMode specified) should be 'reject'
    const h = buildSecurityHarness({});
    server = h.server;
  });
  afterAll(() => server.close());

  it('POST /v1/entitlements/receipt returns 503 when receiptMode is reject (default)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: VALID_RECEIPT,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'receipt_verification_unavailable' });
  });

  it('POST /v1/entitlements/restore returns 503 when receiptMode is reject (default)', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/restore',
      payload: VALID_RESTORE,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'receipt_verification_unavailable' });
  });

  it('explicitly setting receiptMode=reject also rejects', async () => {
    const { server: srv } = buildSecurityHarness({ receiptMode: 'reject' });
    try {
      const res = await srv.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: VALID_RECEIPT,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'receipt_verification_unavailable' });
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Stub mode works (dev only)
// ---------------------------------------------------------------------------

describe('Receipt stub mode (dev-only)', () => {
  let server: FastifyInstance;

  beforeAll(() => {
    const h = buildSecurityHarness({ receiptMode: 'stub' });
    server = h.server;
  });
  afterAll(() => server.close());

  it('POST /v1/entitlements/receipt grants entitlement in stub mode', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId: 'device-stub-test',
        platformReceiptId: 'receipt-stub-001',
        platformReceipt: 'opaque',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignedEnvelope<ReceiptResponsePayload>;
    expect(body.payload.entitlements.some((e) => e.tier === 'time_pass')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Replay protection
// ---------------------------------------------------------------------------

describe('Replay protection', () => {
  let server: FastifyInstance;

  beforeAll(() => {
    const h = buildSecurityHarness({
      receiptMode: 'stub',
      rateLimitMaxRequests: 100, // high limit so rate limit doesn't interfere
    });
    server = h.server;
  });
  afterAll(() => server.close());

  it('same platformReceiptId returns same grant (idempotent, no duplication)', async () => {
    const payload = {
      deviceId: 'device-replay',
      platformReceiptId: 'receipt-replay-001',
      platformReceipt: 'opaque-1',
    };

    const res1 = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload,
    });
    const res2 = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: { ...payload, platformReceipt: 'opaque-2-different' },
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    const body1 = res1.json() as SignedEnvelope<ReceiptResponsePayload>;
    const body2 = res2.json() as SignedEnvelope<ReceiptResponsePayload>;

    // Same entitlements returned — not duplicated
    expect(body1.payload.entitlements).toEqual(body2.payload.entitlements);
    expect(body1.payload.expiryUtc).toBe(body2.payload.expiryUtc);
  });

  it('replayed receipt does not create additional entitlements visible in GET /entitlements', async () => {
    const deviceId = 'device-replay-check';
    const receiptPayload = {
      deviceId,
      platformReceiptId: 'receipt-replay-check',
      platformReceipt: 'opaque',
    };

    // Submit twice
    await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: receiptPayload,
    });
    await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: receiptPayload,
    });

    // Check entitlements — should have exactly 1 time_pass, not 2
    const res = await server.inject({
      method: 'GET',
      url: `/v1/entitlements?deviceId=${deviceId}`,
    });
    const body = res.json() as SignedEnvelope<{ entitlements: Array<{ tier: string }> }>;
    const timePasses = body.payload.entitlements.filter((e) => e.tier === 'time_pass');
    expect(timePasses).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Rate limiting
// ---------------------------------------------------------------------------

describe('Rate limiting on receipt/restore endpoints', () => {
  let server: FastifyInstance;

  beforeAll(() => {
    const h = buildSecurityHarness({
      receiptMode: 'stub',
      rateLimitMaxRequests: 3,
      rateLimitWindowMs: 60_000,
    });
    server = h.server;
  });
  afterAll(() => server.close());

  it('blocks receipt requests after exceeding the limit', async () => {
    const deviceId = 'device-rate-limit';

    // Use distinct receipt IDs so replay protection doesn't interfere
    for (let i = 0; i < 3; i++) {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: {
          deviceId,
          platformReceiptId: `receipt-rl-${i}`,
          platformReceipt: 'opaque',
        },
      });
      expect(res.statusCode).toBe(200);
    }

    // 4th request should be rate-limited
    const blocked = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId,
        platformReceiptId: 'receipt-rl-blocked',
        platformReceipt: 'opaque',
      },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'rate_limit_exceeded' });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('blocks restore requests after exceeding the limit', async () => {
    const deviceId = 'device-rate-limit-restore';

    for (let i = 0; i < 3; i++) {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/restore',
        payload: {
          deviceId,
          receipts: [{ platformReceiptId: `r-${i}`, platformReceipt: 'x' }],
        },
      });
      expect(res.statusCode).toBe(200);
    }

    const blocked = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/restore',
      payload: {
        deviceId,
        receipts: [{ platformReceiptId: 'r-blocked', platformReceipt: 'x' }],
      },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: 'rate_limit_exceeded' });
  });

  it('rate limit is per-device (different devices are independent)', async () => {
    // device-rate-limit already used 3 requests above
    // A different device should still have quota
    const res = await server.inject({
      method: 'POST',
      url: '/v1/entitlements/receipt',
      payload: {
        deviceId: 'device-rate-limit-other',
        platformReceiptId: 'receipt-other-1',
        platformReceipt: 'opaque',
      },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 5. Input validation — malformed bodies return 4xx, never 500
// ---------------------------------------------------------------------------

describe('Input validation (malformed bodies → 4xx)', () => {
  let server: FastifyInstance;

  beforeAll(() => {
    const h = buildSecurityHarness({ receiptMode: 'stub', rateLimitMaxRequests: 1000 });
    server = h.server;
  });
  afterAll(() => server.close());

  describe('POST /v1/entitlements/receipt', () => {
    it('returns 400 for completely empty body', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_receipt' });
    });

    it('returns 400 when deviceId is empty string', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: { deviceId: '', platformReceiptId: 'r', platformReceipt: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_receipt' });
    });

    it('returns 400 when deviceId is a number', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: { deviceId: 12345, platformReceiptId: 'r', platformReceipt: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_receipt' });
    });

    it('returns 400 when platformReceiptId exceeds max length', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        payload: {
          deviceId: 'valid',
          platformReceiptId: 'x'.repeat(5000),
          platformReceipt: 'ok',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_receipt' });
    });

    it('returns 400 when body is null', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/receipt',
        headers: { 'content-type': 'application/json' },
        payload: 'null',
      });
      expect(res.statusCode).toBe(400);
    });

    it('never returns 500 for any of the above', async () => {
      const cases = [
        {},
        { deviceId: null },
        { deviceId: 123, platformReceiptId: true, platformReceipt: [] },
        { deviceId: '', platformReceiptId: '', platformReceipt: '' },
      ];
      for (const payload of cases) {
        const res = await server.inject({
          method: 'POST',
          url: '/v1/entitlements/receipt',
          payload,
        });
        expect(res.statusCode).toBeLessThan(500);
      }
    });
  });

  describe('POST /v1/entitlements/restore', () => {
    it('returns 400 for completely empty body', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/restore',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_restore' });
    });

    it('returns 400 when receipts contains invalid entries', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/restore',
        payload: {
          deviceId: 'valid-device',
          receipts: [{ platformReceiptId: '', platformReceipt: 'x' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_restore' });
    });

    it('returns 400 when receipts entries have oversized fields', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/restore',
        payload: {
          deviceId: 'valid-device',
          receipts: [{ platformReceiptId: 'a'.repeat(5000), platformReceipt: 'x' }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_restore' });
    });

    it('returns 400 when deviceId exceeds max length', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/entitlements/restore',
        payload: { deviceId: 'd'.repeat(5000), receipts: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_restore' });
    });

    it('never returns 500 for malformed inputs', async () => {
      const cases = [
        {},
        { deviceId: 123 },
        { deviceId: 'ok', receipts: 'not-array' },
        { deviceId: 'ok', receipts: [null] },
        { deviceId: 'ok', receipts: [{ platformReceiptId: 123, platformReceipt: true }] },
      ];
      for (const payload of cases) {
        const res = await server.inject({
          method: 'POST',
          url: '/v1/entitlements/restore',
          payload,
        });
        expect(res.statusCode).toBeLessThan(500);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Rate limit applies BEFORE verification gate (save server resources)
// ---------------------------------------------------------------------------

describe('Rate limit applies before verification gate', () => {
  let server: FastifyInstance;

  beforeAll(() => {
    // reject mode + low rate limit
    const h = buildSecurityHarness({
      receiptMode: 'reject',
      rateLimitMaxRequests: 2,
      rateLimitWindowMs: 60_000,
    });
    server = h.server;
  });
  afterAll(() => server.close());

  it('returns 503 until rate limit, then 429', async () => {
    const payload = {
      deviceId: 'device-gate-order',
      platformReceiptId: 'r1',
      platformReceipt: 'x',
    };

    // First 2 requests hit the verification gate (503)
    const res1 = await server.inject({ method: 'POST', url: '/v1/entitlements/receipt', payload });
    expect(res1.statusCode).toBe(503);
    const res2 = await server.inject({ method: 'POST', url: '/v1/entitlements/receipt', payload });
    expect(res2.statusCode).toBe(503);

    // 3rd request is rate-limited (429)
    const res3 = await server.inject({ method: 'POST', url: '/v1/entitlements/receipt', payload });
    expect(res3.statusCode).toBe(429);
  });
});
