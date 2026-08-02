// TourPlaybackScreen — Shows current tour state, synchronized caption, and controls.
//
// FIX 1: Next-POI indicator with name, distance, GPS liveness.
// FIX 2: Replay button wired to `replayLastSegment`.
// FIX 4: Phase labels rewritten as plain rider language.
// FIX 5: Background degradation banner.
// FIX 7: Mid-route boarding notice.
// FIX 8: Accessibility and moving-vehicle ergonomics (44pt targets,
//         WCAG-compliant contrast, live region announcements, removed
//         maxFontSizeMultiplier cap).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { LatLng, TourState } from '../../../engine/src';
import { OfflineMap } from '../../../map/src';
import type { PoiMarker, TilePackRef } from '../../../map/src';
import {
  PLAYBACK_SPEEDS,
  formatPlaybackSpeedLabel,
  type PlaybackSpeed,
} from '../wiring/playbackSpeed';
import { IS_DESK_DEBUG } from '../wiring/deskDebug';
import { DeskTripControls } from '../components/DeskTripControls';
import { NextPoiIndicator } from '../components/NextPoiIndicator';
import { BackgroundBanner } from '../components/BackgroundBanner';
import { MidRouteBoardingNotice } from '../components/MidRouteBoardingNotice';
import { GpsDeliveryBanner } from '../components/GpsDeliveryBanner';
import { RoutePolylinePreview } from '../components/RoutePolylinePreview';
import type { LocationDeliveryStatus } from '../wiring/TourRuntime';
import type { DemoPoi } from '../wiring/demoRoute';
import {
  detectMidRouteBoarding,
  findNextPoi,
  formatDistance,
  getGpsStatus,
  getRiderPhaseLabel,
  precomputePoiAlongRoute,
  resolveSegmentName,
  type MidRouteBoardingInfo,
  type NextPoiInfo,
} from '../components/tourHelpers';

export interface MapPlaybackContext {
  docsDir: string;
  tilePack: TilePackRef;
  initialCenter?: readonly [number, number];
}

export interface TourPlaybackScreenProps {
  state: TourState;
  routeTitle?: string | null;
  caption?: string | null;
  mapContext?: MapPlaybackContext | null;
  playbackSpeed: PlaybackSpeed;
  onPlaybackSpeedChange: (speed: PlaybackSpeed) => void;
  onEndTour: () => void;
  /** Re-speak the most recently played segment. */
  onReplayLastSegment: () => void;
  /** Background status from LocationAdapter. */
  backgroundStatus: { mode: 'background' | 'foreground-only'; reason?: string };
  /** Wall-clock ms of the last accepted GPS fix. */
  lastFixAtMs: number | null;
  /** Map from poiId → human-readable display name. */
  poiNames: ReadonlyMap<string, string>;
  /** Route polyline for along-route projections. */
  routePolyline: readonly LatLng[];
  /** Wave 4: GPS delivery health status. */
  locationDeliveryStatus?: LocationDeliveryStatus;
  /** True when pipeline is rejecting fixes for accuracy. */
  poorAccuracy?: boolean;
  /** Wave 4: Share field diagnostics on explicit user press. */
  onShareFieldDiagnostics?: () => void;
  /** Desk debug panel — only mounted when `IS_DESK_DEBUG` is true. */
  deskDebug?: {
    tripSpeed: number;
    onTripSpeedChange: (speed: number) => void;
    onSkipToNextPoi: () => void;
    replayComplete?: boolean;
  } | null;
}

function getSession(state: TourState) {
  if (
    state.phase === 'Active' ||
    state.phase === 'Standby' ||
    state.phase === 'DeadReckoning' ||
    state.phase === 'Deviation'
  ) {
    return state.session;
  }
  return null;
}

function getPlayingSegmentId(state: TourState): string | null {
  const session = getSession(state);
  return session?.playing?.segmentId ?? null;
}

export function TourPlaybackScreen({
  state,
  routeTitle = null,
  caption = null,
  mapContext = null,
  playbackSpeed,
  onPlaybackSpeedChange,
  onEndTour,
  onReplayLastSegment,
  backgroundStatus,
  lastFixAtMs,
  poiNames,
  routePolyline,
  locationDeliveryStatus,
  poorAccuracy = false,
  onShareFieldDiagnostics,
  deskDebug = null,
}: TourPlaybackScreenProps): ReactElement {
  const session = getSession(state);
  const segmentId = getPlayingSegmentId(state);
  const phaseLabel = getRiderPhaseLabel(state.phase);
  const [narrationSettingsOpen, setNarrationSettingsOpen] = useState(false);

  // ─── FIX 1: Next-POI computation (memoize along-route precomputation) ───
  const geofences = session?.geofences;
  const poisAlongRoute = useMemo(() => {
    if (!geofences) return [];
    return precomputePoiAlongRoute(geofences, routePolyline);
  }, [geofences, routePolyline]);

  // Rider position along route.
  const riderAlongRouteM = session?.lastAccepted?.alongRouteM ?? 0;
  const riderCoord = session?.lastAccepted?.smoothed;
  const consumed = useMemo(() => session?.consumed ?? new Set<string>(), [session?.consumed]);

  const nextPoi: NextPoiInfo | null = useMemo(
    () => findNextPoi(poisAlongRoute, riderAlongRouteM, consumed, poiNames, riderCoord),
    [poisAlongRoute, riderAlongRouteM, consumed, poiNames, riderCoord],
  );

  const formattedDistance = nextPoi ? formatDistance(nextPoi.distanceM) : null;

  // ─── GPS liveness (updates every second) ────────────────────────────────
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  const gpsStatus = getGpsStatus(lastFixAtMs, nowMs);

  // ─── FIX 7: Mid-route boarding detection (only on first fix) ────────────
  const [midRouteInfo, setMidRouteInfo] = useState<MidRouteBoardingInfo | null>(null);
  const midRouteCheckedRef = useRef(false);

  useEffect(() => {
    if (midRouteCheckedRef.current) return;
    if (riderAlongRouteM > 0 && poisAlongRoute.length > 0) {
      midRouteCheckedRef.current = true;
      const info = detectMidRouteBoarding(poisAlongRoute, riderAlongRouteM, consumed);
      setMidRouteInfo(info);
      // Auto-dismiss after 12 seconds.
      if (info) {
        const timer = setTimeout(() => setMidRouteInfo(null), 12_000);
        return () => clearTimeout(timer);
      }
    }
    return undefined;
  }, [riderAlongRouteM, poisAlongRoute, consumed]);

  // ─── FIX 2: Replay enabled when something has played ───────────────────
  const [hasPlayed, setHasPlayed] = useState(false);
  useEffect(() => {
    if (segmentId !== null) setHasPlayed(true);
  }, [segmentId]);

  // ─── FIX 1: Resolve segment name for 'Now playing' ─────────────────────
  const playingName = segmentId ? resolveSegmentName(segmentId, poiNames) : null;

  const showCaption = caption !== null && caption !== '';
  const showBackgroundBanner = backgroundStatus.mode === 'foreground-only';

  const mapPois: PoiMarker[] = useMemo(() => {
    if (!geofences) return [];
    return geofences.flatMap((g) => {
      if (g.geometry.kind !== 'circle') return [];
      return [
        {
          poiId: g.poiId,
          center: g.geometry.center,
          radiusMeters: g.geometry.radiusMeters,
          consumed: consumed.has(g.poiId),
          highlight: nextPoi?.poiId === g.poiId,
        },
      ];
    });
  }, [geofences, consumed, nextPoi?.poiId]);

  const fallbackPreviewPois: DemoPoi[] = useMemo(
    () =>
      mapPois.map((p) => ({
        poiId: p.poiId,
        label: poiNames.get(p.poiId) ?? p.poiId,
      })),
    [mapPois, poiNames],
  );

  const fallbackPoiCenters = useMemo(() => {
    const m = new Map<string, LatLng>();
    for (const p of mapPois) m.set(p.poiId, p.center);
    return m;
  }, [mapPois]);

  const mapCenter = riderCoord ?? mapContext?.initialCenter ?? routePolyline[0];

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title} accessibilityRole="header">
        {routeTitle ?? 'Tour in Progress'}
      </Text>
      {routeTitle ? (
        <Text style={styles.routeSubtitle} accessibilityLabel="Tour status">
          Tour in progress
        </Text>
      ) : null}

      {/* FIX 5: Background degradation banner */}
      {showBackgroundBanner ? <BackgroundBanner reason={backgroundStatus.reason} /> : null}

      {/* Wave 4: GPS delivery health banner */}
      {locationDeliveryStatus ? (
        <GpsDeliveryBanner deliveryStatus={locationDeliveryStatus} poorAccuracy={poorAccuracy} />
      ) : null}

      {/* FIX 7: Mid-route boarding notice */}
      {midRouteInfo ? (
        <MidRouteBoardingNotice
          behindCount={midRouteInfo.behindCount}
          aheadCount={midRouteInfo.aheadCount}
          nextPoiName={poiNames.get(midRouteInfo.nextPoiId) ?? midRouteInfo.nextPoiId}
        />
      ) : null}

      {mapContext ? (
        <View style={styles.mapCard}>
          <OfflineMap
            docsDir={mapContext.docsDir}
            tilePack={mapContext.tilePack}
            {...(mapCenter ? { initialCenter: mapCenter } : {})}
            {...(routePolyline.length >= 2 ? { route: routePolyline } : {})}
            pois={mapPois}
            {...(riderCoord ? { userPosition: riderCoord } : {})}
            initialZoom={15}
            style={styles.map}
          />
        </View>
      ) : routePolyline.length >= 2 ? (
        <View style={styles.mapCard}>
          <RoutePolylinePreview
            route={routePolyline}
            pois={fallbackPreviewPois}
            poiCenters={fallbackPoiCenters}
          />
          <Text style={styles.mapHint} accessibilityLiveRegion="polite">
            {riderCoord
              ? `Rider on route · next: ${
                  nextPoi ? `${nextPoi.name} (${formattedDistance})` : 'end of tour'
                }`
              : 'Waiting for GPS…'}
          </Text>
        </View>
      ) : null}

      {/* FIX 1: Next-POI indicator */}
      <NextPoiIndicator
        nextPoi={nextPoi}
        gpsStatus={gpsStatus}
        formattedDistance={formattedDistance}
      />

      <View style={styles.statusCard}>
        <Text style={styles.phaseLabel} accessibilityLabel={`Status: ${phaseLabel}`}>
          {phaseLabel}
        </Text>

        <View style={styles.segmentRow}>
          <Text style={styles.segmentLabel}>Now playing:</Text>
          <Text
            style={styles.segmentValue}
            accessibilityLabel={
              playingName ? `Playing: ${playingName}` : 'Waiting for next landmark'
            }
          >
            {playingName ?? 'Waiting for next landmark…'}
          </Text>
        </View>
      </View>

      {/* Caption with live region for accessibility announcements */}
      {showCaption ? (
        <View
          style={styles.captionCard}
          accessibilityRole="text"
          accessibilityLabel={`Narration: ${caption}`}
          accessibilityLiveRegion="polite"
        >
          <Text style={styles.captionLabel}>Caption</Text>
          <Text style={styles.captionText}>{caption}</Text>
        </View>
      ) : null}

      {/* Narration speed — collapsed; not a primary ride control */}
      <TouchableOpacity
        style={styles.settingsToggle}
        onPress={() => setNarrationSettingsOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: narrationSettingsOpen }}
        accessibilityLabel="Narration settings"
      >
        <Text style={styles.settingsToggleText}>
          {narrationSettingsOpen ? '▾' : '▸'} Narration settings
        </Text>
      </TouchableOpacity>
      {narrationSettingsOpen ? (
        <View style={styles.speedCard} accessibilityRole="adjustable">
          <Text style={styles.speedLabel}>Voice speed</Text>
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
                  <Text
                    style={[styles.speedButtonText, selected && styles.speedButtonTextSelected]}
                  >
                    {formatPlaybackSpeedLabel(speed)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      ) : null}

      {IS_DESK_DEBUG && deskDebug ? (
        <DeskTripControls
          tripSpeed={deskDebug.tripSpeed}
          onTripSpeedChange={deskDebug.onTripSpeedChange}
          onSkipToNextPoi={deskDebug.onSkipToNextPoi}
          replayComplete={deskDebug.replayComplete === true}
        />
      ) : null}

      {/* FIX 2: Replay + End Tour buttons */}
      <View style={styles.controlRow}>
        <TouchableOpacity
          style={[styles.replayButton, !hasPlayed && styles.replayButtonDisabled]}
          onPress={onReplayLastSegment}
          disabled={!hasPlayed}
          accessibilityRole="button"
          accessibilityLabel="Replay last narration"
          accessibilityState={{ disabled: !hasPlayed }}
        >
          <Text style={[styles.replayButtonText, !hasPlayed && styles.replayButtonTextDisabled]}>
            ↺ Replay
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.endButton}
          onPress={onEndTour}
          accessibilityRole="button"
          accessibilityLabel="End Tour"
        >
          <Text style={styles.endButtonText}>End Tour</Text>
        </TouchableOpacity>
      </View>

      {/* Wave 4: Field diagnostics share — secondary control */}
      {onShareFieldDiagnostics ? (
        <TouchableOpacity
          style={styles.diagnosticsButton}
          onPress={onShareFieldDiagnostics}
          accessibilityRole="button"
          accessibilityLabel="Share field diagnostics report"
          accessibilityHint="Shares a report with no coordinates, route IDs, or personal identifiers"
        >
          <Text style={styles.diagnosticsButtonText}>Share diagnostics</Text>
        </TouchableOpacity>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    padding: 24,
    paddingBottom: 40,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
    color: '#1a1a1a',
    textAlign: 'center',
  },
  routeSubtitle: {
    fontSize: 14,
    color: '#374151',
    marginBottom: 16,
  },
  mapCard: {
    width: '100%',
    marginBottom: 16,
  },
  map: {
    width: '100%',
    height: 280,
    borderRadius: 12,
    overflow: 'hidden',
  },
  mapHint: {
    marginTop: 8,
    fontSize: 13,
    color: '#4b5563',
    textAlign: 'center',
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
    color: '#374151',
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
    color: '#374151',
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
  settingsToggle: {
    width: '100%',
    maxWidth: 400,
    paddingVertical: 10,
    marginBottom: 8,
  },
  settingsToggleText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6b7280',
  },
  speedLabel: {
    fontSize: 13,
    color: '#374151',
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
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d4d4d4',
    backgroundColor: '#ffffff',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
  controlRow: {
    flexDirection: 'row',
    gap: 16,
    alignItems: 'center',
  },
  replayButton: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2563eb',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replayButtonDisabled: {
    borderColor: '#d4d4d4',
    backgroundColor: '#f9fafb',
  },
  replayButtonText: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '600',
  },
  replayButtonTextDisabled: {
    color: '#9ca3af',
  },
  endButton: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  diagnosticsButton: {
    marginTop: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#d4d4d4',
    backgroundColor: '#f9fafb',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  diagnosticsButtonText: {
    color: '#6b7280',
    fontSize: 13,
    fontWeight: '500',
  },
});
