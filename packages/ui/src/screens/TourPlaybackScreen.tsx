// TourPlaybackScreen — Shows current tour state, synchronized caption, and controls.

import type { ReactElement } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { TourState } from '../../../engine/src';
import {
  PLAYBACK_SPEEDS,
  formatPlaybackSpeedLabel,
  type PlaybackSpeed,
} from '../wiring/playbackSpeed';

export interface TourPlaybackScreenProps {
  state: TourState;
  /** Narrative text for the segment currently playing (Req 16.2). */
  caption?: string | null;
  playbackSpeed: PlaybackSpeed;
  onPlaybackSpeedChange: (speed: PlaybackSpeed) => void;
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

export function TourPlaybackScreen({
  state,
  caption = null,
  playbackSpeed,
  onPlaybackSpeedChange,
  onEndTour,
}: TourPlaybackScreenProps): ReactElement {
  const segmentId = getPlayingSegmentId(state);
  const phaseLabel = getPhaseLabel(state.phase);
  const showCaption = caption !== null && caption !== '';

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
            accessibilityLabel={segmentId ? `Playing segment ${segmentId}` : 'Waiting for next POI'}
          >
            {segmentId ?? 'Waiting for next POI...'}
          </Text>
        </View>
      </View>

      {showCaption ? (
        <View
          style={styles.captionCard}
          accessibilityRole="text"
          accessibilityLabel={`Narration caption: ${caption}`}
        >
          <Text style={styles.captionLabel}>Caption</Text>
          <Text style={styles.captionText} maxFontSizeMultiplier={2}>
            {caption}
          </Text>
        </View>
      ) : null}

      <View style={styles.speedCard} accessibilityRole="adjustable">
        <Text style={styles.speedLabel}>Playback speed</Text>
        <View style={styles.speedRow}>
          {PLAYBACK_SPEEDS.map((speed) => {
            const selected = speed === playbackSpeed;
            return (
              <TouchableOpacity
                key={speed}
                style={[styles.speedButton, selected && styles.speedButtonSelected]}
                onPress={() => onPlaybackSpeedChange(speed)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Playback speed ${formatPlaybackSpeedLabel(speed)}`}
              >
                <Text style={[styles.speedButtonText, selected && styles.speedButtonTextSelected]}>
                  {formatPlaybackSpeedLabel(speed)}
                </Text>
              </TouchableOpacity>
            );
          })}
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
    marginBottom: 16,
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
  captionCard: {
    width: '100%',
    backgroundColor: '#fafafa',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#e5e5e5',
  },
  captionLabel: {
    fontSize: 13,
    color: '#666',
    fontWeight: '500',
    marginBottom: 8,
  },
  captionText: {
    fontSize: 16,
    lineHeight: 24,
    color: '#1a1a1a',
  },
  speedCard: {
    width: '100%',
    marginBottom: 24,
  },
  speedLabel: {
    fontSize: 13,
    color: '#666',
    fontWeight: '500',
    marginBottom: 8,
  },
  speedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
  },
  speedButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d4d4d4',
    backgroundColor: '#ffffff',
  },
  speedButtonSelected: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff',
  },
  speedButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#444',
  },
  speedButtonTextSelected: {
    color: '#1d4ed8',
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
