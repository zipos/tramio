// App.tsx — Tramio entry point.
//
// Wires the engine hook to conditional screen rendering:
//   - Idle → RouteSelectionScreen
//   - Active/Standby/DeadReckoning/Deviation → TourPlaybackScreen
//   - Ended → brief "Tour ended" message, then returns to Idle

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useTourEngine } from './packages/ui/src/wiring/useTourEngine';
import { RouteSelectionScreen } from './packages/ui/src/screens/RouteSelectionScreen';
import { TourPlaybackScreen } from './packages/ui/src/screens/TourPlaybackScreen';

export default function App(): ReactElement {
  const { state, startTour, endTour } = useTourEngine();

  // Show "Tour ended" briefly — the engine auto-transitions Ended → Idle
  // via the release-timeout timer (2s), so we just render the message
  // while in the Ended phase.

  const content = (() => {
    switch (state.phase) {
      case 'Idle':
        return <RouteSelectionScreen onStartTour={startTour} />;
      case 'Active':
      case 'Standby':
      case 'DeadReckoning':
      case 'Deviation':
        return <TourPlaybackScreen state={state} onEndTour={endTour} />;
      case 'Ended':
        return (
          <View style={styles.endedContainer}>
            <Text style={styles.endedText} accessibilityRole="header">
              Tour ended
            </Text>
            <Text style={styles.endedSubtext}>Returning to route selection...</Text>
          </View>
        );
    }
  })();

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  endedContainer: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  endedText: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  endedSubtext: {
    fontSize: 15,
    color: '#666',
  },
});
