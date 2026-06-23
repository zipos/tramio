// @tramio/clients
//
// Catalog_Client (probe, lock fetch, ranged asset fetch, moderation refresh)
// and Entitlement_Client (Device_Id, signed cache, receipt validation), plus
// the single HTTP chokepoint that blocks outbound requests during an active
// tour. Implementation lands in tasks 6.2–6.6.

export {
  createHttpClient,
  isLoopbackOrIpc,
  TourActiveBlockError,
  MeteredConnectionBlockError,
} from './http-client';

export type {
  HttpClient,
  HttpClientDeps,
  HttpRequestOptions,
  HttpResponse,
  FetchImpl,
  NetworkInfoProvider,
  RequestIntent,
  TourStateProvider,
} from './http-client';

export {
  createCatalogClient,
  CatalogHttpError,
} from './catalog-client';

export type {
  CatalogClient,
  CatalogClientOptions,
  CatalogBundleEntry,
  CatalogListPayload,
  CatalogStorageProvider,
  ManifestLockAsset,
  ManifestLockPayload,
  ModerationPayload,
  SignedEnvelope,
  UpdateAvailable,
  ProbeResult,
  AssetFetchResult,
} from './catalog-client';

export {
  createEntitlementClient,
  EntitlementHttpError,
} from './entitlement-client';

export type {
  EntitlementClient,
  EntitlementClientOptions,
  EntitlementStorageProvider,
  CachedEntitlementEntry,
  Entitlement,
  EntitlementsPayload,
  ReceiptResponsePayload,
  RestoreResponsePayload,
  ResolvedEntitlements,
  UuidGenerator,
  NowUtcSeconds,
} from './entitlement-client';
