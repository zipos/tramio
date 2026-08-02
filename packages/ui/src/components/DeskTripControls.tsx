// DeskTripControls — __DEV__-only trip scrubber (Next POI + trip speed).
// Do not import this from production UI paths without an IS_DESK_DEBUG gate.

import type { ReactElement } from 'react';
import { useRef } from 'react';
import { PanResponder, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export interface DeskTripControlsProps {
  tripSpeed: number;
  onTripSpeedChange: (speedKmh: number) => void;
  onSkipToNextPoi: () => void;
  replayComplete?: boolean;
}

interface PresetOption {
  kmh: number;
  label: string;
  desc: string;
}

const PRESET_OPTIONS: readonly PresetOption[] = [
  { kmh: 18, label: '18 km/h', desc: 'Tram' },
  { kmh: 21, label: '21 km/h', desc: 'Bus Avg' },
  { kmh: 26, label: '26 km/h', desc: 'Express' },
  { kmh: 35, label: '35 km/h', desc: 'Metro' },
  { kmh: 60, label: '60 km/h', desc: 'Corridor' },
  { kmh: 100, label: '100 km/h', desc: 'High-Speed' },
  { kmh: 300, label: '300 km/h', desc: 'Benchmark' },
];

const MIN_SPEED = 10;
const MAX_SPEED = 300;

function speedToRatio(speed: number): number {
  const s = Math.max(MIN_SPEED, Math.min(MAX_SPEED, speed));
  return Math.log(s / MIN_SPEED) / Math.log(MAX_SPEED / MIN_SPEED);
}

function ratioToSpeed(ratio: number): number {
  const r = Math.max(0, Math.min(1, ratio));
  const raw = MIN_SPEED * Math.pow(MAX_SPEED / MIN_SPEED, r);
  // Snap to preset if close (<4% difference)
  for (const preset of PRESET_OPTIONS) {
    if (Math.abs(raw - preset.kmh) / preset.kmh < 0.06) {
      return preset.kmh;
    }
  }
  return Math.round(raw);
}

export function DeskTripControls({
  tripSpeed,
  onTripSpeedChange,
  onSkipToNextPoi,
  replayComplete = false,
}: DeskTripControlsProps): ReactElement {
  const trackWidthRef = useRef<number>(300);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt) => {
        const x = evt.nativeEvent.locationX;
        const ratio = x / Math.max(1, trackWidthRef.current);
        onTripSpeedChange(ratioToSpeed(ratio));
      },
      onPanResponderMove: (evt) => {
        const x = evt.nativeEvent.locationX;
        const ratio = x / Math.max(1, trackWidthRef.current);
        onTripSpeedChange(ratioToSpeed(ratio));
      },
    }),
  ).current;

  const currentRatio = speedToRatio(tripSpeed);
  const activePreset = PRESET_OPTIONS.find((p) => p.kmh === tripSpeed);

  return (
    <View style={styles.card} accessibilityLabel="Desk debug trip controls">
      <View style={styles.headerRow}>
        <Text style={styles.title}>Desk debug (Test Bench)</Text>
        <Text style={styles.speedBadge}>
          {tripSpeed} km/h {activePreset ? `(${activePreset.desc})` : ''}
        </Text>
      </View>

      {replayComplete ? (
        <Text style={styles.hint}>Trace finished — position held. Next POI still works.</Text>
      ) : (
        <Text style={styles.hint}>
          Next POI seeks forward along the route. Speed slider is logarithmic up to 300 km/h.
        </Text>
      )}

      <TouchableOpacity
        style={styles.nextButton}
        onPress={onSkipToNextPoi}
        accessibilityRole="button"
        accessibilityLabel="Skip to next POI ahead"
      >
        <Text style={styles.nextButtonText}>Next POI</Text>
      </TouchableOpacity>

      {/* Preset Chips */}
      <View style={styles.presetRow}>
        {PRESET_OPTIONS.map((opt) => {
          const selected = opt.kmh === tripSpeed;
          return (
            <TouchableOpacity
              key={opt.kmh}
              style={[styles.presetButton, selected && styles.presetButtonSelected]}
              onPress={() => onTripSpeedChange(opt.kmh)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`Set trip speed to ${opt.kmh} km/h (${opt.desc})`}
            >
              <Text style={[styles.presetText, selected && styles.presetTextSelected]}>
                {opt.kmh}
              </Text>
              <Text style={[styles.presetSubtext, selected && styles.presetSubtextSelected]}>
                {opt.desc}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Logarithmic Speed Slider */}
      <View style={styles.sliderContainer}>
        <Text style={styles.sliderLabel}>Logarithmic Speed Slider (10 - 300 km/h)</Text>
        <View
          style={styles.sliderTrack}
          onLayout={(e) => {
            trackWidthRef.current = e.nativeEvent.layout.width;
          }}
          {...panResponder.panHandlers}
        >
          <View style={[styles.sliderFill, { width: `${Math.round(currentRatio * 100)}%` }]} />
          <View style={[styles.sliderThumb, { left: `${Math.round(currentRatio * 100)}%` }]} />
        </View>
        <View style={styles.sliderTicks}>
          <Text style={styles.tickText}>10 km/h</Text>
          <Text style={styles.tickText}>35 km/h</Text>
          <Text style={styles.tickText}>100 km/h</Text>
          <Text style={styles.tickText}>300 km/h</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 420,
    marginBottom: 16,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fcd34d',
    backgroundColor: '#fffbeb',
    gap: 10,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: '#92400e',
  },
  speedBadge: {
    fontSize: 12,
    fontWeight: '700',
    color: '#b45309',
    backgroundColor: '#fef3c7',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
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
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  presetButton: {
    flex: 1,
    minWidth: 46,
    minHeight: 44,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#f59e0b',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetButtonSelected: {
    backgroundColor: '#f59e0b',
    borderColor: '#b45309',
  },
  presetText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#92400e',
  },
  presetTextSelected: {
    color: '#ffffff',
  },
  presetSubtext: {
    fontSize: 9,
    color: '#b45309',
    marginTop: 1,
  },
  presetSubtextSelected: {
    color: '#fef3c7',
  },
  sliderContainer: {
    marginTop: 4,
    gap: 6,
  },
  sliderLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#a16207',
  },
  sliderTrack: {
    height: 36,
    backgroundColor: '#fde68a',
    borderRadius: 8,
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#f59e0b',
    borderRadius: 8,
  },
  sliderThumb: {
    position: 'absolute',
    width: 14,
    height: 36,
    marginLeft: -7,
    backgroundColor: '#92400e',
    borderRadius: 4,
  },
  sliderTicks: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  tickText: {
    fontSize: 10,
    color: '#a16207',
  },
});
