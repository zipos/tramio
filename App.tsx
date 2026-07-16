// App.tsx — Tramio entry point.

import type { ReactElement } from 'react';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import type { StartTourConfig } from './packages/engine/src';
import type { PackRef } from './packages/storage/src/paths';
import { useTourEngine } from './packages/ui/src/wiring/useTourEngine';
import { findDemoRoute } from './packages/ui/src/wiring/demoRoute';
import { RouteSelectionScreen } from './packages/ui/src/screens/RouteSelectionScreen';
import {
  TourPlaybackScreen,
  type MapPlaybackContext,
} from './packages/ui/src/screens/TourPlaybackScreen';

export default function App(): ReactElement {
  const { state, caption, playbackSpeed, setPlaybackSpeed, startTour, endTour } = useTourEngine();
  const [activeRouteTitle, setActiveRouteTitle] = useState<string | null>(null);
  const [mapContext, setMapContext] = useState<MapPlaybackContext | null>(null);

  const handleStartTour = (
    config: StartTourConfig,
    meta?: {
      title?: string;
      docsDir?: string;
      pack?: PackRef;
      narratives?: Readonly<Record<string, string>>;
    },
  ) => {
    setActiveRouteTitle(meta?.title ?? findDemoRoute(config.bundle.bundleId)?.title ?? null);
    if (meta?.docsDir && meta?.pack) {
      const center = config.route[0];
      setMapContext({
        docsDir: meta.docsDir,
        tilePack: meta.pack,
        ...(center ? { initialCenter: center } : {}),
      });
    } else {
      setMapContext(null);
    }
    startTour(config, meta?.narratives ? { narratives: meta.narratives } : undefined);
  };

  const handleEndTour = () => {
    setMapContext(null);
    endTour();
  };

  const content = (() => {
    switch (state.phase) {
      case 'Idle':
        return <RouteSelectionScreen onStartTour={handleStartTour} />;
      case 'Active':
      case 'Standby':
      case 'DeadReckoning':
      case 'Deviation':
        return (
          <TourPlaybackScreen
            state={state}
            routeTitle={activeRouteTitle}
            caption={caption}
            mapContext={mapContext}
            playbackSpeed={playbackSpeed}
            onPlaybackSpeedChange={setPlaybackSpeed}
            onEndTour={handleEndTour}
          />
        );
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
