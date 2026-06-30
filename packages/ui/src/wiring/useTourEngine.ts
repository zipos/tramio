// useTourEngine — React hook wrapping TourRuntime.
//
// Provides reactive state updates and action methods for starting/ending
// a tour. The TourRuntime instance is created once and shared across the
// app lifetime via useRef.

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

export interface UseTourEngineResult {
  state: TourState;
  /** Narrative caption for the segment currently playing, if any. */
  caption: string | null;
  playbackSpeed: PlaybackSpeed;
  setPlaybackSpeed: (speed: PlaybackSpeed) => void;
  startTour: (config: StartTourConfig) => void;
  endTour: () => void;
}

/**
 * React hook that manages a singleton TourRuntime and exposes reactive
 * state plus action methods.
 *
 * Usage:
 * ```tsx
 * const { state, startTour, endTour } = useTourEngine();
 * ```
 */
export function useTourEngine(): UseTourEngineResult {
  const runtimeRef = useRef<TourRuntime | null>(null);
  const [state, setState] = useState<TourState>(INITIAL_STATE);
  const [playbackSpeed, setPlaybackSpeedState] = useState<PlaybackSpeed>(DEFAULT_PLAYBACK_SPEED);

  // Lazily create the runtime once, wired with the embedded demo narratives.
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      runtimeRef.current?.destroy();
    };
  }, []);

  const startTour = useCallback((config: StartTourConfig) => {
    runtimeRef.current?.start(config);
  }, []);

  const endTour = useCallback(() => {
    runtimeRef.current?.end();
  }, []);

  const setPlaybackSpeed = useCallback((speed: PlaybackSpeed) => {
    runtimeRef.current?.setPlaybackSpeed(speed);
  }, []);

  const caption = resolveNarrativeCaption(getPlayingSegmentId(state));

  return { state, caption, playbackSpeed, setPlaybackSpeed, startTour, endTour };
}
