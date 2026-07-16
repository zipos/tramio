// fetchPackHttpClient — PackHttpClient over the catalog REST API (React Native fetch).

import type { PackRef } from './paths';
import type { PackHttpClient, SignedManifest } from './downloader-types';

export interface FetchPackHttpClientOptions {
  catalogBaseUrl: string;
}

async function readBodyAsIterable(response: Response): Promise<AsyncIterable<Uint8Array>> {
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    return (async function* () {
      yield buf;
    })();
  }

  const reader = response.body.getReader();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * HTTP client for OfflinePackDownloader using `fetch` (Expo / RN).
 */
export function createFetchPackHttpClient(opts: FetchPackHttpClientOptions): PackHttpClient {
  const base = opts.catalogBaseUrl.replace(/\/+$/, '');

  return {
    async fetchManifest(ref: PackRef): Promise<SignedManifest> {
      const url = `${base}/v1/catalog/${encodeURIComponent(ref.bundleId)}/${encodeURIComponent(ref.version)}/manifest.lock.json`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`manifest.lock fetch failed: ${res.status}`);
      }
      return (await res.json()) as SignedManifest;
    },

    async fetchAsset(ref: PackRef, assetPath: string): Promise<AsyncIterable<Uint8Array>> {
      const url = `${base}/v1/catalog/${encodeURIComponent(ref.bundleId)}/${encodeURIComponent(ref.version)}/asset/${assetPath}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`asset fetch failed (${assetPath}): ${res.status}`);
      }
      return readBodyAsIterable(res);
    },
  };
}
