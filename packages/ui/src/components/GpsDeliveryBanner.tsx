// GpsDeliveryBanner — Wave 4 UI component showing GPS delivery health.
//
// Distinguishes three states:
//   - 'recovering': "Location updates stalled — recovering…"
//   - 'stalled': "Location updates stalled"
//   - poor accuracy (live but repeated rejections): "GPS data arriving but accuracy poor"
//
// Does NOT imply recovery succeeded until a new raw callback arrives
// (status transitions to 'live' only on actual delivery).

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LocationDeliveryStatus } from '../wiring/TourRuntime';

export interface GpsDeliveryBannerProps {
  deliveryStatus: LocationDeliveryStatus;
  /** Whether last few fixes were rejected for accuracy. */
  poorAccuracy?: boolean;
}

/**
 * Returns the appropriate banner or null if status is nominal.
 */
export function GpsDeliveryBanner({
  deliveryStatus,
  poorAccuracy = false,
}: GpsDeliveryBannerProps): ReactElement | null {
  if (deliveryStatus === 'live' && !poorAccuracy) return null;
  if (deliveryStatus === 'acquiring') return null;

  let message: string;
  let severity: 'warning' | 'error';

  if (deliveryStatus === 'recovering') {
    message = 'Location updates stalled — recovering…';
    severity = 'warning';
  } else if (deliveryStatus === 'stalled') {
    message = 'Location updates stalled';
    severity = 'error';
  } else if (poorAccuracy) {
    message = 'GPS data arriving but accuracy poor';
    severity = 'warning';
  } else {
    return null;
  }

  return (
    <View
      style={[styles.banner, severity === 'error' ? styles.bannerError : styles.bannerWarning]}
      accessibilityRole="alert"
      accessibilityLabel={message}
      accessibilityLiveRegion="assertive"
    >
      <Text style={[styles.text, severity === 'error' ? styles.textError : styles.textWarning]}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    width: '100%',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    marginBottom: 12,
  },
  bannerWarning: {
    backgroundColor: '#fef3c7',
  },
  bannerError: {
    backgroundColor: '#fee2e2',
  },
  text: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
  textWarning: {
    color: '#92400e',
  },
  textError: {
    color: '#991b1b',
  },
});
