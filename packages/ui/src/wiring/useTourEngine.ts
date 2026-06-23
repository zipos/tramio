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
import { sampleNarrativeResolver } from './sampleNarratives';

export interface UseTourEngineResult {
  state: TourState;
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

  // Lazily create the runtime once, wired with the embedded demo narratives.
  if (runtimeRef.current === null) {
    runtimeRef.current = new TourRuntime({ narrativeResolver: sampleNarrativeResolver });
  }

  useEffect(() => {
    const runtime = runtimeRef.current!;
    const unsub = runtime.subscribe((newState) => {
      setState(newState);
    });
    return () => {
      unsub();
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

  return { state, startTour, endTour };
}
