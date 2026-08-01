// useTourEngine — React hook wrapping TourRuntime.
//
// PUBLIC CONTRACT (consumed by a parallel UX agent):
//   - replayLastSegment: () => void  — re-speaks most recently played segment
//   - backgroundStatus: { mode: 'background' | 'foreground-only'; reason?: string }
//   - lastFixAtMs: number | null     — wall-clock ms of last accepted fix
//   - locationDeliveryStatus: LocationDeliveryStatus — Wave 4 delivery health
//   - shareFieldDiagnostics: () => Promise<void> — explicit share only

import { useCallback, useEffect, useRef, useState } from 'react';
import { Share } from 'react-native';
import type { TourState } from '../../../engine/src';
import { INITIAL_STATE } from '../../../engine/src';
import type { StartTourConfig } from '../../../engine/src';
import {
  TourRuntime,
  type BackgroundStatus,
  type SpeechStatus,
  type LocationDeliveryStatus,
} from './TourRuntime';
import { ExpoAudioPlaybackAdapter } from './ExpoAudioPlaybackAdapter';
import {
  resolveNarrativeCaption,
  sampleNarrativeResolver,
  sampleSegmentStyle,
} from './sampleNarratives';
import { DEFAULT_PLAYBACK_SPEED, type PlaybackSpeed } from './playbackSpeed';

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

export interface StartTourOptions {
  /** Pack-backed narratives keyed by `{poiId}:{lang}`. Merged over embedded demo text. */
  narratives?: Readonly<Record<string, string>>;
  /** Delivery tone per POI id. Used to build a segment style resolver for pack tours. */
  tones?: Readonly<Record<string, 'standard' | 'memorial'>>;
}

export interface UseTourEngineResult {
  state: TourState;
  caption: string | null;
  playbackSpeed: PlaybackSpeed;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  startTour: (config: StartTourConfig, options?: StartTourOptions) => void;
  endTour: () => void;
  /** Re-speaks the most recently played segment's text. No-op if nothing played yet. */
  replayLastSegment: () => void;
  /** Real background-location status for UI warnings. */
  backgroundStatus: BackgroundStatus;
  /** Wall-clock ms of the last accepted location fix (null between tours). */
  lastFixAtMs: number | null;
  /**
   * Whether narration can actually be spoken on this device. A device with no
   * TTS engine installed reports `available: false` — surface this to the
   * rider, because otherwise the tour looks like it is working while being
   * completely silent.
   */
  speechStatus: SpeechStatus;
  /**
   * Wave 4: GPS delivery health. Distinguishes "provider delivering but
   * accuracy poor" from "provider completely silent (stalled)."
   */
  locationDeliveryStatus: LocationDeliveryStatus;
  /**
   * Wave 4: Share field diagnostics report via system share sheet.
   * Only fires on explicit user press. Contains no coordinates or PII.
   */
  shareFieldDiagnostics: () => Promise<void>;
}

export function useTourEngine(): UseTourEngineResult {
  const runtimeRef = useRef<TourRuntime | null>(null);
  const packNarrativesRef = useRef<Readonly<Record<string, string>>>({});
  const [state, setState] = useState<TourState>(INITIAL_STATE);
  const [playbackSpeed, setPlaybackSpeedState] = useState<PlaybackSpeed>(DEFAULT_PLAYBACK_SPEED);
  const [backgroundStatus, setBackgroundStatus] = useState<BackgroundStatus>({
    mode: 'foreground-only',
    reason: 'unavailable',
  });
  const [lastFixAtMs, setLastFixAtMs] = useState<number | null>(null);
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>({ available: true });
  const [locationDeliveryStatus, setLocationDeliveryStatus] =
    useState<LocationDeliveryStatus>('acquiring');

  if (runtimeRef.current === null) {
    runtimeRef.current = new TourRuntime({
      narrativeResolver: sampleNarrativeResolver,
      segmentStyleResolver: sampleSegmentStyle,
      audioPort: new ExpoAudioPlaybackAdapter(),
    });
  }

  useEffect(() => {
    const runtime = runtimeRef.current!;
    const unsubState = runtime.subscribe((newState) => {
      setState(newState);
    });
    const unsubSpeed = runtime.subscribePlaybackSpeed((speed) => {
      setPlaybackSpeedState(speed);
    });
    const unsubBg = runtime.subscribeBackgroundStatus((status) => {
      setBackgroundStatus(status);
    });
    const unsubFix = runtime.subscribeLastFix((ms) => {
      setLastFixAtMs(ms);
    });
    const unsubSpeech = runtime.subscribeSpeechStatus((status) => {
      setSpeechStatus(status);
    });
    const unsubDelivery = runtime.subscribeLocationDeliveryStatus((status) => {
      setLocationDeliveryStatus(status);
    });
    return () => {
      unsubState();
      unsubSpeed();
      unsubBg();
      unsubFix();
      unsubSpeech();
      unsubDelivery();
    };
  }, []);

  useEffect(() => {
    return () => {
      runtimeRef.current?.destroy();
    };
  }, []);

  const startTour = useCallback((config: StartTourConfig, options?: StartTourOptions) => {
    const packNarratives = options?.narratives ?? {};
    packNarrativesRef.current = packNarratives;
    const resolver = (segmentId: string) =>
      packNarratives[segmentId] ?? sampleNarrativeResolver(segmentId);
    runtimeRef.current?.setNarrativeResolver(resolver);

    const packTones = options?.tones;
    if (packTones && Object.keys(packTones).length > 0) {
      const styleResolver = (segmentId: string) => {
        const colonIdx = segmentId.lastIndexOf(':');
        const poiId = colonIdx === -1 ? segmentId : segmentId.slice(0, colonIdx);
        const tone = packTones[poiId] ?? 'standard';
        return tone === 'memorial' ? { rateMultiplier: 0.9 } : null;
      };
      runtimeRef.current?.setSegmentStyleResolver(styleResolver);
    } else {
      runtimeRef.current?.setSegmentStyleResolver(sampleSegmentStyle);
    }

    runtimeRef.current?.start(config);
  }, []);

  const endTour = useCallback(() => {
    runtimeRef.current?.end();
  }, []);

  const setPlaybackSpeed = useCallback((speed: PlaybackSpeed) => {
    runtimeRef.current?.setPlaybackSpeed(speed);
  }, []);

  const replayLastSegment = useCallback(() => {
    runtimeRef.current?.replayLastSegment();
  }, []);

  const shareFieldDiagnostics = useCallback(async () => {
    const report = runtimeRef.current?.getFieldDiagnosticsReport();
    if (!report) return;
    try {
      await Share.share({ message: report });
    } catch {
      // User dismissed or Share is unavailable — do not crash.
    }
  }, []);

  const caption = resolveNarrativeCaption(getPlayingSegmentId(state), packNarrativesRef.current);

  return {
    state,
    caption,
    playbackSpeed,
    setPlaybackSpeed,
    startTour,
    endTour,
    replayLastSegment,
    backgroundStatus,
    lastFixAtMs,
    speechStatus,
    locationDeliveryStatus,
    shareFieldDiagnostics,
  };
}
