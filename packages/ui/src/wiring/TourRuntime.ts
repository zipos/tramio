// TourRuntime — Command translator bridging the pure engine reducer
// with autolinked Expo native modules.
//
// The custom turbo modules under packages/native/ are NOT autolinked into
// the Expo prebuild, so this runtime drives:
//   - expo-location (via LocationAdapter + the engine JS geofence pipeline)
//   - expo-speech   (for TTS narration)
//   - expo-keep-awake (to keep the screen/CPU alive during a tour)
//
// It holds the current TourState, dispatches EngineEvents through the
// reducer, and executes resulting EngineCommands against those modules.
// Narrative text for each POI is supplied via a `narrativeResolver` so
// the runtime stays decoupled from bundle storage.

import * as Speech from 'expo-speech';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import type { EngineCommand, EngineEvent, TourState, StartTourConfig } from '../../../engine/src';
import { INITIAL_STATE, reduce } from '../../../engine/src';
import { LocationAdapter } from './locationAdapter';

export type StateListener = (state: TourState) => void;

/**
 * Resolves the narrative text to speak for a given segment id.
 * Segment ids follow the reducer convention `{poiId}:{lang}`.
 * Returns `null` if no narrative is available (runtime falls back to a
 * generic line so playback still completes and the tour advances).
 */
export type NarrativeResolver = (segmentId: string) => string | null;

export interface TourRuntimeOptions {
  /** Maps a segmentId to the narrative text to speak. */
  narrativeResolver?: NarrativeResolver;
  /** Speech language override; defaults to the tour config language. */
  speechLanguage?: string;
}

export class TourRuntime {
  private state: TourState = INITIAL_STATE;
  private config: StartTourConfig | undefined;
  private listeners = new Set<StateListener>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private locationAdapter: LocationAdapter | null = null;
  private readonly narrativeResolver: NarrativeResolver;

  constructor(opts?: TourRuntimeOptions) {
    this.narrativeResolver = opts?.narrativeResolver ?? (() => null);
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Start a tour. Begins watching location and dispatches start. */
  start(config: StartTourConfig): void {
    this.config = config;
    void activateKeepAwakeAsync('tramio-tour').catch(() => undefined);

    this.locationAdapter = new LocationAdapter(config.route, config.geofences, {
      onAccepted: (update) => {
        this.dispatch({ kind: 'LocationAccepted', update });
      },
      onGeofenceDwell: (poiId) => {
        this.dispatch({ kind: 'GeofenceDwell', poiId });
      },
      onPermissionDenied: () => {
        // Without location we cannot run a tour; end it cleanly.
        this.dispatch({ kind: 'UserCommand', cmd: 'end' });
      },
    });
    void this.locationAdapter.start().catch(() => {
      this.dispatch({ kind: 'UserCommand', cmd: 'end' });
    });

    this.dispatch({ kind: 'UserCommand', cmd: 'start' });
  }

  /** End the current tour. */
  end(): void {
    this.dispatch({ kind: 'UserCommand', cmd: 'end' });
  }

  getState(): TourState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispatch(event: EngineEvent): void {
    const result = reduce(this.state, event, Date.now(), this.config);
    this.state = result.state;
    this.notifyListeners();
    this.executeCommands(result.commands);
  }

  destroy(): void {
    this.locationAdapter?.stop();
    this.locationAdapter = null;
    void Speech.stop().catch(() => undefined);
    deactivateKeepAwake('tramio-tour').catch(() => undefined);
    this.cancelAllTimers();
    this.listeners.clear();
  }

  // ─── Command execution ──────────────────────────────────────────────

  private executeCommands(commands: readonly EngineCommand[]): void {
    for (const cmd of commands) this.executeCommand(cmd);
  }

  private executeCommand(cmd: EngineCommand): void {
    switch (cmd.kind) {
      case 'PlaySegment':
        this.handlePlaySegment(cmd.segmentId);
        break;
      case 'StopAudio':
        void Speech.stop().catch(() => undefined);
        break;
      case 'PauseAudio':
        // expo-speech pause support is platform-dependent; stop is the
        // reliable cross-platform behavior. The engine re-issues a play
        // on resume if needed.
        void Speech.stop().catch(() => undefined);
        break;
      case 'ResumeAudio':
        // No offset resume for TTS; the next GeofenceDwell will trigger
        // fresh narration. Nothing to do here.
        break;
      case 'RequestLocationMode':
        // expo-location runs a single high-accuracy watch for the whole
        // tour; mode transitions are a no-op at this layer.
        break;
      case 'ScheduleTimer':
        this.scheduleTimer(cmd.id, cmd.afterMs);
        break;
      case 'CancelTimer':
        this.cancelTimer(cmd.id);
        break;
      case 'ReleaseAll':
        this.handleReleaseAll();
        break;
      case 'ShowDeviationPrompt':
      case 'HideDeviationPrompt':
      case 'RequestDecryptedSegment':
        break;
    }
  }

  private handlePlaySegment(segmentId: string): void {
    const text =
      this.narrativeResolver(segmentId) ??
      'Approaching a point of interest along your route.';
    const language = this.config?.language ?? 'en';
    // Stop anything in flight to preserve the single-segment invariant,
    // then speak. `onDone` feeds AudioFinished back into the reducer so
    // the POI is marked consumed.
    void Speech.stop().catch(() => undefined);
    Speech.speak(text, {
      language,
      onDone: () => this.dispatch({ kind: 'AudioFinished', segmentId }),
      onStopped: () => this.dispatch({ kind: 'AudioFinished', segmentId }),
      onError: () => this.dispatch({ kind: 'AudioFinished', segmentId }),
    });
  }

  private handleReleaseAll(): void {
    this.locationAdapter?.stop();
    this.locationAdapter = null;
    void Speech.stop().catch(() => undefined);
    deactivateKeepAwake('tramio-tour').catch(() => undefined);
  }

  // ─── Timer management ───────────────────────────────────────────────

  private scheduleTimer(id: string, afterMs: number): void {
    this.cancelTimer(id);
    const handle = setTimeout(() => {
      this.timers.delete(id);
      this.dispatch({ kind: 'Timer', id, firedAt: Date.now() });
    }, afterMs);
    this.timers.set(id, handle);
  }

  private cancelTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
  }

  private cancelAllTimers(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
  }

  // ─── Listener notification ──────────────────────────────────────────

  private notifyListeners(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
