// NextPoiIndicator — Shows the next upcoming POI name, distance, and GPS status.
//
// This component addresses the "dead zone" problem: during the 2–5 minutes
// between POIs the rider needs visual confirmation that the app is working.
// It shows (a) the name of the next landmark ahead, (b) approximate distance,
// and (c) a GPS liveness indicator.
//
// @see FIX 1 in the UX spec.

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { GpsStatus, NextPoiInfo } from './tourHelpers';

export interface NextPoiIndicatorProps {
  nextPoi: NextPoiInfo | null;
  gpsStatus: GpsStatus;
  formattedDistance: string | null;
}

export function NextPoiIndicator({
  nextPoi,
  gpsStatus,
  formattedDistance,
}: NextPoiIndicatorProps): ReactElement {
  return (
    <View
      style={styles.container}
      accessibilityRole="summary"
      accessibilityLabel={
        nextPoi
          ? `Next landmark: ${nextPoi.name}, ${formattedDistance ?? 'distance unknown'}. GPS ${gpsStatus === 'live' ? 'active' : 'acquiring signal'}.`
          : `No more landmarks ahead. GPS ${gpsStatus === 'live' ? 'active' : 'acquiring signal'}.`
      }
    >
      <View style={styles.gpsRow}>
        <View
          style={[styles.gpsDot, gpsStatus === 'live' ? styles.gpsDotLive : styles.gpsDotAcquiring]}
        />
        <Text style={styles.gpsText}>{gpsStatus === 'live' ? 'GPS active' : 'Acquiring GPS…'}</Text>
      </View>

      {nextPoi ? (
        <View style={styles.poiRow}>
          <Text style={styles.nextLabel}>Next</Text>
          <Text style={styles.poiName} numberOfLines={2}>
            {nextPoi.name}
          </Text>
          {formattedDistance ? <Text style={styles.distance}>{formattedDistance}</Text> : null}
        </View>
      ) : (
        <View style={styles.poiRow}>
          <Text style={styles.poiName}>No more landmarks ahead</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#f0fdf4',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#bbf7d0',
  },
  gpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  gpsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  gpsDotLive: {
    backgroundColor: '#16a34a',
  },
  gpsDotAcquiring: {
    backgroundColor: '#f59e0b',
  },
  gpsText: {
    fontSize: 12,
    fontWeight: '500',
    color: '#374151',
  },
  poiRow: {
    gap: 4,
  },
  nextLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  poiName: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  distance: {
    fontSize: 14,
    color: '#374151',
    marginTop: 2,
  },
});
