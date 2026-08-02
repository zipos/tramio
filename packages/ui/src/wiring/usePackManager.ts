// usePackManager — device storage, catalog probe, and pack download.

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  OfflinePackDownloader,
  createFetchPackHttpClient,
  loadPackTour,
  openDeviceStorage,
  recoverDeviceStorage,
  resetDeviceStorageCache,
  verifyManifestSignatureSpki,
  PackIntegrityError,
  type LoadedPackTour,
  type StorageManager,
  type ManifestVerifier,
} from '../../../storage/src/mobile';
import {
  DEV_CATALOG_KID,
  DEV_CATALOG_PUBLIC_KEY_SPKI_B64URL,
} from '../../../clients/src/catalogPublicKey';

export interface CatalogRouteEntry {
  bundleId: string;
  version: string;
  sizeBytes: number;
  title: string;
  description: string;
}

export type PackInstallState = 'unknown' | 'missing' | 'downloading' | 'ready' | 'error';

import { formatCatalogUnreachableMessage, resolveCatalogBaseUrl } from './resolveCatalogBaseUrl';

const ROUTE_COPY: Readonly<Record<string, { title: string; description: string }>> = {
  'warsaw-bus-180-north': {
    title: 'Warsaw Bus 180 — northbound',
    description:
      'Wilanów → Żoliborz along the Trakt Królewski, then through Muranów and Powązki. Northbound only; the southbound direction ships as a separate bundle.',
  },
};

function routeKey(bundleId: string, version: string): string {
  return `${bundleId}@${version}`;
}

const manifestVerifier: ManifestVerifier = {
  verify: (signed: Parameters<typeof verifyManifestSignatureSpki>[1]) =>
    verifyManifestSignatureSpki(DEV_CATALOG_PUBLIC_KEY_SPKI_B64URL, signed, DEV_CATALOG_KID),
};

export interface UsePackManagerResult {
  storage: StorageManager | null;
  /** True while the first open (or a retry) is in flight. */
  storageOpening: boolean;
  routes: readonly CatalogRouteEntry[];
  installState: Readonly<Record<string, PackInstallState>>;
  /** Storage / pack download failures. */
  error: string | null;
  /** Dev catalog probe — non-fatal; embedded routes still work. */
  catalogWarning: string | null;
  catalogBaseUrl: string;
  /** Retry opening local storage (deletes DB if a prior open hung). */
  retryStorage: () => void;
  refreshCatalog: () => Promise<void>;
  downloadPack: (bundleId: string, version: string) => Promise<void>;
  loadInstalledTour: (bundleId: string, version: string) => Promise<LoadedPackTour>;
  isPackReady: (bundleId: string, version: string) => Promise<boolean>;
}

export function usePackManager(): UsePackManagerResult {
  const [storage, setStorage] = useState<StorageManager | null>(null);
  const [routes, setRoutes] = useState<readonly CatalogRouteEntry[]>([]);
  const [installState, setInstallState] = useState<Readonly<Record<string, PackInstallState>>>({});
  const [error, setError] = useState<string | null>(null);
  const [catalogWarning, setCatalogWarning] = useState<string | null>(null);
  const [storageRetry, setStorageRetry] = useState(0);
  const [storageOpening, setStorageOpening] = useState(true);

  const catalogBaseUrl = useMemo(() => resolveCatalogBaseUrl(), []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    setStorageOpening(true);
    setError(null);

    const open =
      storageRetry === 0
        ? openDeviceStorage()
        : recoverDeviceStorage().catch(() => openDeviceStorage());

    const timed = new Promise<StorageManager>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Opening local storage timed out. Tap Retry.'));
      }, 10_000);
      open.then(resolve, reject);
    });

    timed
      .then((mgr) => {
        if (!cancelled) {
          setStorage(mgr);
          setStorageOpening(false);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        resetDeviceStorageCache();
        if (!cancelled) {
          setStorage(null);
          setStorageOpening(false);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [storageRetry]);

  const retryStorage = useCallback(() => {
    resetDeviceStorageCache();
    setStorageRetry((n) => n + 1);
  }, []);

  const refreshCatalog = useCallback(async () => {
    setCatalogWarning(null);
    try {
      const res = await fetch(`${catalogBaseUrl}/v1/catalog`);
      if (!res.ok) throw new Error(`catalog ${res.status}`);
      const body = (await res.json()) as {
        payload: { bundles: Array<{ bundleId: string; version: string; sizeBytes: number }> };
        signature: string;
        kid: string;
      };
      const signatureOk = await verifyManifestSignatureSpki(
        DEV_CATALOG_PUBLIC_KEY_SPKI_B64URL,
        body,
        DEV_CATALOG_KID,
      );
      if (!signatureOk) {
        throw new Error('catalog signature did not verify');
      }
      const entries = body.payload.bundles.map((b) => {
        const copy = ROUTE_COPY[b.bundleId];
        return {
          bundleId: b.bundleId,
          version: b.version,
          sizeBytes: b.sizeBytes,
          title: copy?.title ?? b.bundleId,
          description: copy?.description ?? 'Offline tour pack',
        };
      });
      setRoutes(entries);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      setCatalogWarning(`${formatCatalogUnreachableMessage(catalogBaseUrl)} (${detail})`);
    }
  }, [catalogBaseUrl]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const downloader = useMemo(() => {
    if (!storage) return null;
    return new OfflinePackDownloader({
      storage,
      http: createFetchPackHttpClient({ catalogBaseUrl }),
      manifestVerifier,
    });
  }, [storage, catalogBaseUrl]);

  const isPackReady = useCallback(
    async (bundleId: string, version: string) => {
      if (!downloader) return false;
      return downloader.isPackStartable(bundleId, version);
    },
    [downloader],
  );

  useEffect(() => {
    if (!downloader || routes.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, PackInstallState> = {};
      for (const route of routes) {
        const key = routeKey(route.bundleId, route.version);
        // eslint-disable-next-line no-await-in-loop
        next[key] = (await downloader.isPackStartable(route.bundleId, route.version))
          ? 'ready'
          : 'missing';
      }
      if (!cancelled) setInstallState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [downloader, routes]);

  const downloadPack = useCallback(
    async (bundleId: string, version: string) => {
      if (!downloader) {
        setError('Storage is still opening. Try again in a moment.');
        return;
      }
      const key = routeKey(bundleId, version);
      setInstallState((prev) => ({ ...prev, [key]: 'downloading' }));
      setError(null);
      try {
        const result = await downloader.download(bundleId, version);
        if (!result.ok) {
          throw new Error(result.errors[0]?.message ?? 'download failed');
        }
        setInstallState((prev) => ({ ...prev, [key]: 'ready' }));
      } catch (err: unknown) {
        setInstallState((prev) => ({ ...prev, [key]: 'error' }));
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [downloader],
  );

  const loadInstalledTour = useCallback(
    async (bundleId: string, version: string) => {
      try {
        if (!storage) throw new Error('storage not ready');
        const ready = await downloader?.isPackStartable(bundleId, version);
        if (!ready) throw new Error('pack not installed');
        return await loadPackTour(storage, { bundleId, version }, manifestVerifier);
      } catch (err: unknown) {
        if (err instanceof PackIntegrityError) {
          setError(err.userMessage);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    [storage, downloader],
  );

  return {
    storage,
    storageOpening,
    routes,
    installState,
    error,
    catalogWarning,
    catalogBaseUrl,
    retryStorage,
    refreshCatalog,
    downloadPack,
    loadInstalledTour,
    isPackReady,
  };
}
