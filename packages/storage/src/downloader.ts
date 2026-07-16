// Offline_Pack downloader — Node entry (tests + backend tooling).
//
// React Native resolves `./downloader.native.ts` instead of this file.

export * from './downloader-types';
export { sortByDependencyOrder, canonicalJsonStringify } from './downloader-core';
export { verifyManifestSignature, createNodeManifestVerifier } from './downloader-node';

import type { KeyObject } from 'node:crypto';

import { OfflinePackDownloader as CoreDownloader } from './downloader-core';
import type { ManifestVerifier, PackHttpClient } from './downloader-types';
import type { StorageManager } from './manager';
import { createNodeManifestVerifier } from './downloader-node';

/** Node test / tooling options — accepts legacy `verificationKey`. */
export interface OfflinePackDownloaderOptions {
  readonly storage: StorageManager;
  readonly http: PackHttpClient;
  readonly verificationKey?: KeyObject;
  readonly manifestVerifier?: ManifestVerifier;
}

/**
 * Node downloader — accepts `verificationKey` for unit tests.
 * On React Native, Metro resolves `downloader.native.ts` instead.
 */
export class OfflinePackDownloader extends CoreDownloader {
  constructor(opts: OfflinePackDownloaderOptions) {
    const manifestVerifier =
      opts.manifestVerifier ??
      (opts.verificationKey ? createNodeManifestVerifier(opts.verificationKey) : undefined);
    if (!manifestVerifier) {
      throw new Error('OfflinePackDownloader: verificationKey or manifestVerifier is required');
    }
    super({ storage: opts.storage, http: opts.http, manifestVerifier });
  }
}
