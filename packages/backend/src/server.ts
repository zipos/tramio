/**
 * Fastify app factory for the Tramio MVP backend.
 *
 * Exports `buildServer(opts)` which returns a configured `FastifyInstance`
 * without calling `.listen()`. Tests (smoke + integration in task 6.7) and
 * the production runner (`bin/serve.ts`) both go through this factory so
 * one code path serves all environments.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { signEnvelope } from './envelope';
import { createKeyRegistry, type KeyRegistry } from './keys';
import { signBytes, canonicalJsonStringify } from './signing';
import { parseRange } from './range';
import { createBackendStore, type BackendStore, type BackendStoreOptions } from './store';
import type {
  CatalogListPayload,
  EntitlementsPayload,
  GtfsLatestPayload,
  ManifestLockPayload,
  ModerationPayload,
  ReceiptRequest,
  ReceiptResponsePayload,
  RestoreRequest,
  RestoreResponsePayload,
} from './types';

export interface BuildServerOptions {
  /** Pre-built store; defaults to `createBackendStore(storeOptions)`. */
  readonly store?: BackendStore;
  /** Used only when `store` is omitted. */
  readonly storeOptions?: BackendStoreOptions;
  /** Pre-built key registry; defaults to `createKeyRegistry()`. */
  readonly keys?: KeyRegistry;
  /**
   * Route under which clients can fetch the detached MANIFEST.lock.sig.
   * Surfaced in the asset response header. Defaults to
   * `/v1/catalog/{bundleId}/{version}/manifest.lock.sig`.
   */
  readonly manifestSignatureRoute?: (bundleId: string, version: string) => string;
  /** Forwarded to Fastify's logger setting. */
  readonly logger?: boolean;
}

interface CatalogParams {
  bundleId: string;
  version: string;
}
interface CatalogAssetParams extends CatalogParams {
  '*': string;
}
interface GtfsParams {
  cityId: string;
}
interface EntitlementsQuery {
  deviceId?: string;
}

/**
 * Build the Fastify instance. No `.listen()` here — the caller is in charge
 * of wiring up the actual transport (or letting Fastify's `inject()` do it
 * in tests).
 */
export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const fastify = Fastify({ logger: opts.logger ?? false });
  const keys = opts.keys ?? createKeyRegistry();
  const store = opts.store ?? createBackendStore(opts.storeOptions ?? {});
  const manifestSigRoute =
    opts.manifestSignatureRoute ??
    ((bundleId: string, version: string) =>
      `/v1/catalog/${encodeURIComponent(bundleId)}/${encodeURIComponent(version)}/manifest.lock.sig`);

  // --- /v1/catalog ---------------------------------------------------------
  fastify.get('/v1/catalog', async (_req, reply) => {
    const payload: CatalogListPayload = store.listCatalog();
    return reply.send(signEnvelope(keys.getActive('cat'), payload));
  });

  // --- /v1/catalog/:bundleId/:version/manifest.lock.json -------------------
  fastify.get<{ Params: CatalogParams }>(
    '/v1/catalog/:bundleId/:version/manifest.lock.json',
    async (req, reply) => {
      const { bundleId, version } = req.params;
      const manifest = store.getManifest(bundleId, version);
      if (!manifest) return reply.code(404).send({ error: 'manifest_not_found' });
      const env = signEnvelope<ManifestLockPayload>(keys.getActive('cat'), manifest);
      return reply.send(env);
    },
  );

  // --- /v1/catalog/:bundleId/:version/manifest.lock.sig --------------------
  // Detached signature over the *canonical* JSON encoding of the manifest
  // lock payload. Bytes match what `signEnvelope` signed for
  // /manifest.lock.json. Body is a small JSON object so the wire format is
  // self-describing without needing a separate content type negotiation.
  fastify.get<{ Params: CatalogParams }>(
    '/v1/catalog/:bundleId/:version/manifest.lock.sig',
    async (req, reply) => {
      const { bundleId, version } = req.params;
      const manifest = store.getManifest(bundleId, version);
      if (!manifest) return reply.code(404).send({ error: 'manifest_not_found' });
      const key = keys.getActive('cat');
      const canonical = canonicalJsonStringify(manifest);
      const signature = signBytes(key.privateKey, Buffer.from(canonical, 'utf8'));
      return reply.send({ signature, kid: key.kid });
    },
  );

  // --- /v1/catalog/:bundleId/:version/asset/* ------------------------------
  // Range-supported asset serving. We intentionally stream as a Buffer slice
  // so the smoke tests can exercise the 206 path without a real filesystem.
  fastify.get<{ Params: CatalogAssetParams }>(
    '/v1/catalog/:bundleId/:version/asset/*',
    async (req, reply) => {
      const { bundleId, version } = req.params;
      const path = (req.params as CatalogAssetParams)['*'];
      if (typeof path !== 'string' || path.length === 0) {
        return reply.code(400).send({ error: 'asset_path_required' });
      }
      const asset = await store.readAsset(bundleId, version, path);
      if (!asset) return reply.code(404).send({ error: 'asset_not_found' });

      // Always advertise where the detached manifest signature lives so the
      // client can verify the overall pack integrity for THIS asset run.
      reply.header('X-Manifest-Lock-Sig-Url', manifestSigRoute(bundleId, version));
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Content-Type', 'application/octet-stream');

      const rangeHeader = req.headers.range;
      const range = parseRange(rangeHeader, asset.sizeBytes);
      if (range.kind === 'unsatisfiable') {
        reply.header('Content-Range', `bytes */${asset.sizeBytes}`);
        return reply.code(416).send();
      }

      if (range.kind === 'absent') {
        reply.header('Content-Length', String(asset.sizeBytes));
        const bytes = await asset.read(0, asset.sizeBytes - 1);
        return reply.code(200).send(bytes);
      }

      const { start, end } = range;
      reply.header('Content-Range', `bytes ${start}-${end}/${asset.sizeBytes}`);
      reply.header('Content-Length', String(end - start + 1));
      const slice = await asset.read(start, end);
      return reply.code(206).send(slice);
    },
  );

  // --- /v1/gtfs/:cityId/latest --------------------------------------------
  fastify.get<{ Params: GtfsParams }>('/v1/gtfs/:cityId/latest', async (req, reply) => {
    const { cityId } = req.params;
    const latest = store.getGtfsLatest(cityId);
    if (!latest) return reply.code(404).send({ error: 'gtfs_not_found' });
    const env = signEnvelope<GtfsLatestPayload>(keys.getActive('cat'), latest);
    return reply.send(env);
  });

  // --- /v1/entitlements ----------------------------------------------------
  fastify.get<{ Querystring: EntitlementsQuery }>('/v1/entitlements', async (req, reply) => {
    const deviceId = readDeviceId(req);
    if (!deviceId) return reply.code(400).send({ error: 'device_id_required' });
    const { entitlements, expiryUtc } = store.resolveEntitlements(deviceId);
    const payload: EntitlementsPayload = { deviceId, entitlements, expiryUtc };
    return reply.send(signEnvelope(keys.getActive('ent'), payload));
  });

  // --- POST /v1/entitlements/receipt --------------------------------------
  fastify.post<{ Body: Partial<ReceiptRequest> }>(
    '/v1/entitlements/receipt',
    async (req, reply) => {
      const body = req.body ?? {};
      if (
        typeof body.deviceId !== 'string' ||
        typeof body.platformReceiptId !== 'string' ||
        typeof body.platformReceipt !== 'string'
      ) {
        return reply.code(400).send({ error: 'invalid_receipt' });
      }
      // The MVP grants a single time_pass per receipt. The full validation
      // pipeline lands when the platform stores wire up (post-MVP). Until
      // then the backend trusts the receipt format and grants a 24h pass.
      const grantedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const recorded = store.recordReceipt(body.deviceId, body.platformReceiptId, [
        { tier: 'time_pass', grantedAt, expiresAt },
      ]);
      const payload: ReceiptResponsePayload = {
        deviceId: recorded.deviceId,
        platformReceiptId: recorded.platformReceiptId,
        entitlements: recorded.entitlements,
        expiryUtc: recorded.expiryUtc,
      };
      return reply.send(signEnvelope(keys.getActive('ent'), payload));
    },
  );

  // --- POST /v1/entitlements/restore --------------------------------------
  fastify.post<{ Body: Partial<RestoreRequest> }>(
    '/v1/entitlements/restore',
    async (req, reply) => {
      const body = req.body ?? {};
      if (
        typeof body.deviceId !== 'string' ||
        !Array.isArray(body.receipts) ||
        !body.receipts.every(
          (r) =>
            r != null &&
            typeof (r as { platformReceiptId?: unknown }).platformReceiptId === 'string' &&
            typeof (r as { platformReceipt?: unknown }).platformReceipt === 'string',
        )
      ) {
        return reply.code(400).send({ error: 'invalid_restore' });
      }
      const ids = body.receipts.map((r) => r.platformReceiptId);
      const { entitlements, expiryUtc } = store.restoreReceipts(body.deviceId, ids);
      const payload: RestoreResponsePayload = {
        deviceId: body.deviceId,
        entitlements,
        expiryUtc,
      };
      return reply.send(signEnvelope(keys.getActive('ent'), payload));
    },
  );

  // --- GET /v1/moderation -------------------------------------------------
  fastify.get('/v1/moderation', async (_req, reply) => {
    const payload: ModerationPayload = store.getModeration();
    return reply.send(signEnvelope(keys.getActive('cat'), payload));
  });

  return fastify;
}

/**
 * Resolve the Device_Id from either the `?deviceId=` query string or the
 * `X-Device-Id` header. Design.md specifies header-based auth but the GET
 * /v1/entitlements row in the API table uses a `?deviceId=` query, so we
 * accept both for ergonomics.
 */
function readDeviceId(req: FastifyRequest): string | undefined {
  const q = (req.query as { deviceId?: unknown } | undefined)?.deviceId;
  if (typeof q === 'string' && q.length > 0) return q;
  const h = req.headers['x-device-id'];
  if (typeof h === 'string' && h.length > 0) return h;
  if (Array.isArray(h) && h.length > 0 && typeof h[0] === 'string') return h[0];
  return undefined;
}
