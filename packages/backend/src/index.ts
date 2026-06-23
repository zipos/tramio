// @tramio/backend
//
// Self-hosted Fastify backend exposing the API surface from design.md
// "Backend API Surface". Catalog_Service, Entitlement_Service, and the
// Moderation Store all share one signing key registry; payloads ride
// inside `{ payload, signature, kid }` envelopes (Ed25519, canonical JSON).
export { buildServer, type BuildServerOptions } from './server';
export {
  createBackendStore,
  type BackendStore,
  type BackendStoreOptions,
  type RecordedReceipt,
  type AssetReadResult,
} from './store';
export {
  createKeyRegistry,
  DEFAULT_CATALOG_KID,
  DEFAULT_ENTITLEMENT_KID,
  type KeyRegistry,
  type KeyEntry,
  type KeyClass,
  type PublicKeyDescriptor,
} from './keys';
export {
  signPayload,
  verifyPayload,
  signBytes,
  verifyBytes,
  canonicalJsonStringify,
  base64urlEncode,
  base64urlDecode,
  generateEd25519KeyPair,
  exportPublicKeySpkiB64Url,
  importPublicKeySpkiB64Url,
} from './signing';
export { signEnvelope, type SignedEnvelope } from './envelope';
export type {
  CatalogBundleEntry,
  CatalogListPayload,
  Entitlement,
  EntitlementsPayload,
  GtfsLatestPayload,
  ManifestLockAsset,
  ManifestLockAssetEncryption,
  ManifestLockPayload,
  ModerationPayload,
  ReceiptRequest,
  ReceiptResponsePayload,
  RestoreRequest,
  RestoreResponsePayload,
} from './types';
export { parseRange, type ParsedRange, type ResolvedRange } from './range';
