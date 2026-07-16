// androidPermissions — runtime grants required before Android foreground services.

import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Android 13+ requires POST_NOTIFICATIONS before a foreground-service
 * notification can be shown (expo-location background updates use one).
 */
export async function ensureAndroidPostNotificationsPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const apiLevel =
    typeof Platform.Version === 'number'
      ? Platform.Version
      : Number.parseInt(String(Platform.Version), 10);
  if (!Number.isFinite(apiLevel) || apiLevel < 33) {
    return true;
  }

  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  const already = await PermissionsAndroid.check(permission);
  if (already) {
    return true;
  }

  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
