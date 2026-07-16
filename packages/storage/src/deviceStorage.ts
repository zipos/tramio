// deviceStorage — open Storage_Manager on a React Native / Expo device.

import type { StorageManager } from './manager';
import { createExpoFsPort, resolveExpoDocumentDirectory } from './expoFsPort';
import { openExpoSqliteDriver } from './expoSqliteDriver';

/**
 * Construct a ready StorageManager for on-device use (expo-sqlite + expo-file-system).
 */
export async function openDeviceStorage(): Promise<StorageManager> {
  const { StorageManager: Manager } = await import('./manager');
  const docsDir = resolveExpoDocumentDirectory();
  const driver = await openExpoSqliteDriver();
  return Manager.open({
    layout: { docsDir },
    driver,
    fs: createExpoFsPort(),
  });
}
