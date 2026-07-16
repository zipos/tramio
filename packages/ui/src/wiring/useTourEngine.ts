// useTourEngine — React hook wrapping TourRuntime.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TourState } from '../../../engine/src';
import { INITIAL_STATE } from '../../../engine/src';
import type { StartTourConfig } from '../../../engine/src';
import { TourRuntime } from './TourRuntime';
import { resolveNarrativeCaption, sampleNarrativeResolver } from './sampleNarratives';
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
}

export interface UseTourEngineResult {
  state: TourState;
  caption: string | null;
  playbackSpeed: PlaybackSpeed;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  startTour: (config: StartTourConfig, options?: StartTourOptions) => void;
  endTour: () => void;
}

export function useTourEngine(): UseTourEngineResult {
  const runtimeRef = useRef<TourRuntime | null>(null);
  const packNarrativesRef = useRef<Readonly<Record<string, string>>>({});
  const [state, setState] = useState<TourState>(INITIAL_STATE);
  const [playbackSpeed, setPlaybackSpeedState] = useState<PlaybackSpeed>(DEFAULT_PLAYBACK_SPEED);

  if (runtimeRef.current === null) {
    runtimeRef.current = new TourRuntime({ narrativeResolver: sampleNarrativeResolver });
  }

  useEffect(() => {
    const runtime = runtimeRef.current!;
    const unsubState = runtime.subscribe((newState) => {
      setState(newState);
    });
    const unsubSpeed = runtime.subscribePlaybackSpeed((speed) => {
      setPlaybackSpeedState(speed);
    });
    return () => {
      unsubState();
      unsubSpeed();
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
    runtimeRef.current?.start(config);
  }, []);

  const endTour = useCallback(() => {
    runtimeRef.current?.end();
  }, []);

  const setPlaybackSpeed = useCallback((speed: PlaybackSpeed) => {
    runtimeRef.current?.setPlaybackSpeed(speed);
  }, []);

  const caption = resolveNarrativeCaption(getPlayingSegmentId(state), packNarrativesRef.current);

  return { state, caption, playbackSpeed, setPlaybackSpeed, startTour, endTour };
}
