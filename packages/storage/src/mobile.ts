// React Native / Expo entry for @tramio/storage.
//
// Import from here in app code — never from `./index`, which pulls in
// Node-only modules (better-sqlite3, node:fs, GTFS parser, etc.).

export { openDeviceStorage } from './deviceStorage';
export { loadPackTour, type LoadedPackTour } from './packLoader';
export { createFetchPackHttpClient, type FetchPackHttpClientOptions } from './fetchPackHttpClient';
export { verifyManifestSignatureSpki } from './signatureVerify';
export { PackIntegrityError, type PackIntegrityKind } from './packIntegrity';
export { SIGNED_LOCK_RELATIVE_PATH, CONTROL_DIR } from './controlFile';
export { AsyncMutex } from './asyncMutex';
export {
  OfflinePackDownloader,
  sortByDependencyOrder,
  canonicalJsonStringify,
  type ManifestVerifier,
  type DownloadError,
  type DownloadErrorKind,
  type DownloadResult,
  type ManifestLockAsset,
  type ManifestLockAssetEncryption,
  type ManifestLockPayload,
  type OfflinePackDownloaderOptions,
  type PackHttpClient,
  type SignedManifest,
} from './downloader.native';
export type { StorageManager } from './manager';
export type { PackRef } from './paths';
