// TourPlaybackScreen — Shows current tour state and playback info.
//
// Displays the engine phase, currently playing segment (if any), and
// an "End Tour" button.

import type { ReactElement } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { TourState } from '../../../engine/src';

export interface TourPlaybackScreenProps {
  state: TourState;
  onEndTour: () => void;
}

function getPlayingSegmentId(state: TourState): string | null {
  if (
    state.phase === 'Active' ||
    state.phase === 'Standby' ||
    state.phase === 'DeadReckoning' ||
    state.phase === 'Deviation'
  ) {
    return state.session.playing?.segmentId ?? null;
  }
  return null;
}

function getPhaseLabel(phase: TourState['phase']): string {
  switch (phase) {
    case 'Active':
      return 'Active — Listening for POIs';
    case 'Standby':
      return 'Standby — Waiting for motion';
    case 'DeadReckoning':
      return 'Dead Reckoning — GPS signal lost';
    case 'Deviation':
      return 'Deviation — Off route';
    default:
      return phase;
  }
}

export function TourPlaybackScreen({ state, onEndTour }: TourPlaybackScreenProps): ReactElement {
  const segmentId = getPlayingSegmentId(state);
  const phaseLabel = getPhaseLabel(state.phase);

  return (
    <View style={styles.container}>
      <Text style={styles.title} accessibilityRole="header">
        Tour in Progress
      </Text>

      <View style={styles.statusCard}>
        <Text style={styles.phaseLabel} accessibilityLabel={`Tour phase: ${phaseLabel}`}>
          {phaseLabel}
        </Text>

        <View style={styles.segmentRow}>
          <Text style={styles.segmentLabel}>Now playing:</Text>
          <Text
            style={styles.segmentValue}
            accessibilityLabel={
              segmentId ? `Playing segment ${segmentId}` : 'Waiting for next POI'
            }
          >
            {segmentId ?? 'Waiting for next POI...'}
          </Text>
        </View>
      </View>

      <TouchableOpacity
        style={styles.endButton}
        onPress={onEndTour}
        accessibilityRole="button"
        accessibilityLabel="End Tour"
      >
        <Text style={styles.endButtonText}>End Tour</Text>
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
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 24,
    color: '#1a1a1a',
  },
  statusCard: {
    width: '100%',
    backgroundColor: '#f0f9ff',
    borderRadius: 12,
    padding: 20,
    marginBottom: 32,
  },
  phaseLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e40af',
    marginBottom: 12,
  },
  segmentRow: {
    flexDirection: 'column',
    gap: 4,
  },
  segmentLabel: {
    fontSize: 13,
    color: '#666',
    fontWeight: '500',
  },
  segmentValue: {
    fontSize: 15,
    color: '#1a1a1a',
  },
  endButton: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
  },
  endButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
