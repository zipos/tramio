// RouteSelectionScreen — Lists available routes and starts a tour.
//
// For the MVP, a single hardcoded route is shown. The user taps
// "Start Tour" to begin the Wrocław Tram 7 East experience.

import type { ReactElement } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { StartTourConfig } from '../../../engine/src';

export interface RouteSelectionScreenProps {
  onStartTour: (config: StartTourConfig) => void;
}

// Warsaw Tram 22 — eastbound along Aleje Jerozolimskie, across the
// Poniatowski Bridge to PGE Narodowy. Coordinates are approximate
// landmark centers; refine against survey/GTFS data before release.
const HARDCODED_CONFIG: StartTourConfig = {
  bundle: { bundleId: 'warsaw-tram-22-east', bundleVersion: '1.0.0' },
  geofences: [
    {
      poiId: 'poi-pkin',
      geometry: { kind: 'circle', center: [52.2305, 21.0065], radiusMeters: 150 },
      dwellSec: 3,
      priority: 90,
      authorIndex: 0,
    },
    {
      poiId: 'poi-muzeum-narodowe',
      geometry: { kind: 'circle', center: [52.2316, 21.0246], radiusMeters: 90 },
      dwellSec: 3,
      priority: 70,
      authorIndex: 1,
    },
    {
      poiId: 'poi-stadion-narodowy',
      geometry: { kind: 'circle', center: [52.2394, 21.0455], radiusMeters: 150 },
      dwellSec: 3,
      priority: 80,
      authorIndex: 2,
    },
  ],
  route: [
    [52.2289, 21.0034],
    [52.2305, 21.0065],
    [52.2316, 21.0246],
    [52.233, 21.033],
    [52.2375, 21.042],
    [52.2394, 21.0455],
  ],
  language: 'pl',
};

export function RouteSelectionScreen({ onStartTour }: RouteSelectionScreenProps): ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Tramio
      </Text>
      <Text style={styles.subtitle}>Choose a route to begin your audio tour.</Text>

      <View style={styles.routeCard}>
        <Text style={styles.routeName} accessibilityLabel="Route: Warsaw Tram 22 East">
          Warsaw Tram 22 — East
        </Text>
        <Text style={styles.routeDescription}>
          Ride east along Aleje Jerozolimskie across the Vistula to the National
          Stadium, with stories along the way.
        </Text>
      </View>

      <TouchableOpacity
        style={styles.startButton}
        onPress={() => onStartTour(HARDCODED_CONFIG)}
        accessibilityRole="button"
        accessibilityLabel="Start Tour"
      >
        <Text style={styles.startButtonText}>Start Tour</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 8,
    color: '#1a1a1a',
  },
  subtitle: {
    fontSize: 15,
    color: '#666',
    marginBottom: 32,
    textAlign: 'center',
  },
  routeCard: {
    width: '100%',
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
  },
  routeName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    marginBottom: 6,
  },
  routeDescription: {
    fontSize: 14,
    color: '#555',
    lineHeight: 20,
  },
  startButton: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
  },
  startButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
