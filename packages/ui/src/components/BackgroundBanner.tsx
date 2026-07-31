// BackgroundBanner — Non-blocking warning when background playback is degraded.
//
// Shown during a tour when `backgroundStatus.mode === 'foreground-only'`.
// Maps the `reason` to specific rider-facing guidance about what to enable
// in device settings.
//
// @see FIX 5 in the UX spec.

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getBackgroundGuidance } from './tourHelpers';

export interface BackgroundBannerProps {
  reason?: string | undefined;
}

export function BackgroundBanner({ reason }: BackgroundBannerProps): ReactElement {
  const guidance = getBackgroundGuidance(reason);

  return (
    <View style={styles.container} accessibilityRole="alert" accessibilityLabel={guidance}>
      <Text style={styles.icon}>⚠️</Text>
      <Text style={styles.text}>{guidance}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  icon: {
    fontSize: 16,
    marginTop: 1,
  },
  text: {
    flex: 1,
    fontSize: 13,
    color: '#92400e',
    lineHeight: 18,
  },
});
