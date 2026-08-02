// DeskTripControls — __DEV__-only trip scrubber (Next POI + trip speed).
// Do not import this from production UI paths without an IS_DESK_DEBUG gate.

import type { ReactElement } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { DESK_TRIP_SPEEDS } from '../wiring/deskDebug';

export interface DeskTripControlsProps {
  tripSpeed: number;
  onTripSpeedChange: (speed: number) => void;
  onSkipToNextPoi: () => void;
  replayComplete?: boolean;
}

export function DeskTripControls({
  tripSpeed,
  onTripSpeedChange,
  onSkipToNextPoi,
  replayComplete = false,
}: DeskTripControlsProps): ReactElement {
  return (
    <View style={styles.card} accessibilityLabel="Desk debug trip controls">
      <Text style={styles.title}>Desk debug</Text>
      {replayComplete ? (
        <Text style={styles.hint}>Trace finished — position held. Next POI still works.</Text>
      ) : (
        <Text style={styles.hint}>Next POI seeks GPS + audio. Trip speed is wall-clock.</Text>
      )}
      <TouchableOpacity
        style={styles.nextButton}
        onPress={onSkipToNextPoi}
        accessibilityRole="button"
        accessibilityLabel="Skip to next POI"
      >
        <Text style={styles.nextButtonText}>Next POI</Text>
      </TouchableOpacity>
      <View style={styles.speedRow}>
        {DESK_TRIP_SPEEDS.map((speed) => {
          const selected = speed === tripSpeed;
          return (
            <TouchableOpacity
              key={speed}
              style={[styles.speedButton, selected && styles.speedButtonSelected]}
              onPress={() => onTripSpeedChange(speed)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Trip speed ${speed}x`}
            >
              <Text style={[styles.speedText, selected && styles.speedTextSelected]}>{speed}x</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 16,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
    gap: 10,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: '#92400e',
  },
  hint: {
    fontSize: 12,
    color: '#a16207',
    lineHeight: 16,
  },
  nextButton: {
    backgroundColor: '#d97706',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  nextButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  speedRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  speedButton: {
    minWidth: 56,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#f59e0b',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedButtonSelected: {
    backgroundColor: '#f59e0b',
    borderColor: '#b45309',
  },
  speedText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#92400e',
  },
  speedTextSelected: {
    color: '#ffffff',
  },
});
