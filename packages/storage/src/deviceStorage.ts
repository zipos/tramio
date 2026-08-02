// deviceStorage — open Storage_Manager on a React Native / Expo device.
//
// Singleton: remounts / Fast Refresh must not open a second expo-sqlite
// handle on the same file (that can hang forever after a force-quit).

import type { StorageManager } from './manager';
import { createExpoFsPort, resolveExpoDocumentDirectory } from './expoFsPort';
import { openExpoSqliteDriver } from './expoSqliteDriver';

let openPromise: Promise<StorageManager> | null = null;

async function openDeviceStorageImpl(): Promise<StorageManager> {
  const { StorageManager: Manager } = await import('./manager');
  const docsDir = resolveExpoDocumentDirectory();
  const driver = await openExpoSqliteDriver();
  return Manager.open({
    layout: { docsDir },
    driver,
    fs: createExpoFsPort(),
  });
}

/**
 * Construct a ready StorageManager for on-device use (expo-sqlite + expo-file-system).
 * Concurrent callers share one in-flight open. Failed opens clear the cache so
 * the next call can retry.
 */
export function openDeviceStorage(): Promise<StorageManager> {
  if (openPromise === null) {
    openPromise = openDeviceStorageImpl().catch((err: unknown) => {
      openPromise = null;
      throw err;
    });
  }
  return openPromise;
}

/** Drop the cached open so the next call opens fresh (retry after hang/timeout). */
export function resetDeviceStorageCache(): void {
  openPromise = null;
}

/**
 * Last-resort recovery: close cache, delete the on-device DB file, open again.
 * Used when open hangs or fails after an unclean app kill.
 */
export async function recoverDeviceStorage(): Promise<StorageManager> {
  openPromise = null;
  try {
    const { deleteDatabaseAsync } = await import('expo-sqlite');
    await deleteDatabaseAsync('tramio.db');
  } catch {
    // File may not exist — continue to open.
  }
  return openDeviceStorage();
}
