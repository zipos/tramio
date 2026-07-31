// TourRuntime — Command translator bridging the pure engine reducer
// with autolinked Expo native modules.
//
// The custom turbo modules under packages/native/ are NOT autolinked into
// the Expo prebuild, so this runtime drives:
//   - expo-location (via LocationAdapter + the engine JS geofence pipeline)
//   - expo-speech   (for TTS narration)
//   - expo-keep-awake (to keep the screen/CPU alive during a tour)
//   - expo-audio    (audio session configuration for background playback)
//
// It holds the current TourState, dispatches EngineEvents through the
// reducer, and executes resulting EngineCommands against those modules.
// Narrative text for each POI is supplied via a `narrativeResolver` so
// the runtime stays decoupled from bundle storage.
//
// BUG 2 FIX: Deliberate-stop tracking. Every Speech.stop() we initiate
// sets `deliberateStop = true`; the onStopped callback checks this flag.
// OS-level interruptions (phone calls, Siri, audio focus loss) arrive as
// non-deliberate stops and dispatch FocusLoss instead of AudioFinished,
// leaving the POI unconsumed so it can replay.
//
// BUG 5 FIX: After a pipeline fire, we advance the stored pipeline state's
// consumed set so the pipeline short-circuits that POI on subsequent fixes.

import * as Speech from 'expo-speech';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { AppState, type NativeEventSubscription } from 'react-native';

import type { EngineCommand, EngineEvent, TourState, StartTourConfig } from '../../../engine/src';
import { INITIAL_STATE, reduce } from '../../../engine/src';
import { LocationAdapter } from './locationAdapter';
import { DEFAULT_PLAYBACK_SPEED, type PlaybackSpeed } from './playbackSpeed';
import { configureTourAudioSession, releaseTourAudioSession } from './audioSession';

export type StateListener = (state: TourState) => void;

/**
 * Resolves the narrative text to speak for a given segment id.
 * Segment ids follow the reducer convention `{poiId}:{lang}`.
 * Returns `null` if no narrative is available (runtime falls back to a
 * generic line so playback still completes and the tour advances).
 */
export type NarrativeResolver = (segmentId: string) => string | null;

/**
 * Delivery style for a segment, applied on top of the user's chosen
 * playback speed.
 *
 * This exists so that content of different weight is not all delivered
 * in the same register. Memorial material (Holocaust sites, cemeteries)
 * is authored with a sub-1 multiplier so it is spoken more slowly than
 * a note about a shopping centre. Returning `null` means "no
 * adjustment".
 */
export type SegmentStyleResolver = (
  segmentId: string,
) => { readonly rateMultiplier: number } | null;

export interface TourRuntimeOptions {
  /** Maps a segmentId to the narrative text to speak. */
  narrativeResolver?: NarrativeResolver;
  /** Maps a segmentId to a delivery-rate adjustment. */
  segmentStyleResolver?: SegmentStyleResolver;
  /** Speech language override; defaults to the tour config language. */
  speechLanguage?: string;
}

/** Background status exposed to the UI for a "no background" warning. */
export interface BackgroundStatus {
  mode: 'background' | 'foreground-only';
  reason?: string;
}

export type BackgroundStatusListener = (status: BackgroundStatus) => void;
export type LastFixListener = (ms: number | null) => void;

/**
 * Whether narration can actually be spoken on this device.
 *
 * expo-speech is a thin wrapper over the platform TTS engine. An Android
 * device may have NO engine installed, or none set as default, in which case
 * `Speech.speak()` silently no-ops: no onStart, no onDone, no onError, no
 * onStopped. Because the reducer only clears `session.playing` on
 * AudioFinished, that silence strands the engine mid-segment and the
 * single-segment invariant then suppresses EVERY remaining POI for the rest
 * of the ride. So a missing TTS engine is not merely "narration is quiet" —
 * it hangs the tour on POI #1.
 *
 * Two defences: probe for voices at tour start, and watchdog every utterance.
 */
export interface SpeechStatus {
  available: boolean;
  reason?: 'no-engine' | 'no-voice-for-language' | 'failed';
}

export type SpeechStatusListener = (status: SpeechStatus) => void;

/** No onStart inside this window ⇒ no usable TTS engine on this device. */
const SPEECH_START_TIMEOUT_MS = 4_000;
/** Approximate spoken words per second at rate 1.0, for watchdog sizing. */
const WORDS_PER_SECOND = 2.5;
/** Slack added on top of the estimated utterance duration. */
const SPEECH_DONE_GRACE_MS = 10_000;

export class TourRuntime {
  private state: TourState = INITIAL_STATE;
  private config: StartTourConfig | undefined;
  private listeners = new Set<StateListener>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private locationAdapter: LocationAdapter | null = null;
  private narrativeResolver: NarrativeResolver;
  private segmentStyleResolver: SegmentStyleResolver;
  private playbackSpeed: PlaybackSpeed = DEFAULT_PLAYBACK_SPEED;
  private playbackSpeedListeners = new Set<(speed: PlaybackSpeed) => void>();

  // ─── BUG 2: deliberate-stop tracking ──────────────────────────────
  // When WE initiate a Speech.stop(), we set this flag BEFORE the call.
  // The onStopped callback checks and clears it. If the flag is NOT set,
  // the stop was an OS interruption → dispatch FocusLoss, not AudioFinished.
  private deliberateStop = false;
  // Track if we are inside PauseAudio handling to prevent recursion.
  private isPausingAudio = false;
  // The segmentId currently being spoken (needed for onStopped/onDone routing).
  private currentSegmentId: string | null = null;
  // Track focus-loss state so we know when to dispatch FocusRegain.
  private focusLost = false;
  // AppState subscription for FocusRegain dispatch.
  private appStateSubscription: NativeEventSubscription | null = null;

  // ─── PUBLIC CONTRACT: replay, background status, last fix ─────────
  private lastSpokenText: string | null = null;
  private lastSpokenLanguage = 'en';
  private lastSpokenRate = 1.0;

  private backgroundStatus: BackgroundStatus = { mode: 'foreground-only', reason: 'unavailable' };
  private backgroundStatusListeners = new Set<BackgroundStatusListener>();

  private lastFixAtMs: number | null = null;
  private lastFixListeners = new Set<LastFixListener>();

  // ─── Speech watchdog (missing-TTS-engine detection) ────────────────
  private speechStartTimer: ReturnType<typeof setTimeout> | null = null;
  private speechDoneTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStatus: SpeechStatus = { available: true };
  private speechStatusListeners = new Set<SpeechStatusListener>();

  constructor(opts?: TourRuntimeOptions) {
    this.narrativeResolver = opts?.narrativeResolver ?? (() => null);
    this.segmentStyleResolver = opts?.segmentStyleResolver ?? (() => null);
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Start a tour. Begins watching location and dispatches start. */
  start(config: StartTourConfig): void {
    this.config = config;

    // BUG 1 FIX: activate the audio session for background + silent-mode playback.
    void configureTourAudioSession().catch(() => undefined);

    void activateKeepAwakeAsync('tramio-tour').catch(() => undefined);

    // Reset per-tour state.
    this.lastFixAtMs = null;
    this.notifyLastFix();
    this.focusLost = false;
    this.deliberateStop = false;
    this.clearSpeechWatchdogs();
    this.speechStatus = { available: true };

    // Probe for a usable TTS voice up front. A device with no TTS engine
    // installed would otherwise fail silently on the first POI.
    void this.probeSpeechAvailability(config.language);

    // Subscribe to AppState for FocusRegain dispatch after phone calls etc.
    this.appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && this.focusLost) {
        this.focusLost = false;
        this.dispatch({ kind: 'FocusRegain' });
      }
    });

    this.locationAdapter = new LocationAdapter(config.route, config.geofences, {
      onAccepted: (update) => {
        this.lastFixAtMs = Date.now();
        this.notifyLastFix();
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

    // Wire background status reporting from the adapter.
    this.locationAdapter.onBackgroundStatusChange = (status) => {
      this.backgroundStatus = status;
      this.notifyBackgroundStatus();
    };

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

  getPlaybackSpeed(): PlaybackSpeed {
    return this.playbackSpeed;
  }

  setPlaybackSpeed(speed: PlaybackSpeed): void {
    this.playbackSpeed = speed;
    for (const listener of this.playbackSpeedListeners) listener(speed);
  }

  /** Replace the narrative resolver (e.g. when starting a pack-backed tour). */
  setNarrativeResolver(resolver: NarrativeResolver): void {
    this.narrativeResolver = resolver;
  }

  /** Replace the segment style resolver (e.g. when starting a pack-backed tour). */
  setSegmentStyleResolver(resolver: SegmentStyleResolver): void {
    this.segmentStyleResolver = resolver;
  }

  subscribePlaybackSpeed(listener: (speed: PlaybackSpeed) => void): () => void {
    this.playbackSpeedListeners.add(listener);
    return () => {
      this.playbackSpeedListeners.delete(listener);
    };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeBackgroundStatus(listener: BackgroundStatusListener): () => void {
    this.backgroundStatusListeners.add(listener);
    return () => {
      this.backgroundStatusListeners.delete(listener);
    };
  }

  subscribeLastFix(listener: LastFixListener): () => void {
    this.lastFixListeners.add(listener);
    return () => {
      this.lastFixListeners.delete(listener);
    };
  }

  getBackgroundStatus(): BackgroundStatus {
    return this.backgroundStatus;
  }

  getLastFixAtMs(): number | null {
    return this.lastFixAtMs;
  }

  /**
   * Re-speak the most recently played segment.
   *
   * TOUR-KILLER FIX: the previous implementation always spoke without
   * callbacks. If Replay was tapped while the engine still owned a playing
   * segment, the pre-emptive stop was swallowed as deliberate and the
   * callback-free utterance never dispatched AudioFinished — so
   * `session.playing` stayed set forever and the single-segment invariant
   * suppressed every remaining POI for the rest of the ride.
   *
   * So: if the engine still owns a segment, replay IS that segment and must
   * carry its engine callbacks. Only once the segment has been consumed
   * (playing cleared) is a pure-UI, callback-free replay safe.
   */
  replayLastSegment(): void {
    if (this.lastSpokenText === null) return;

    const playing = this.getPlayingSegment();
    const engineSegmentId = playing ? playing.segmentId : null;

    if (engineSegmentId !== null) {
      this.currentSegmentId = engineSegmentId;
    }

    // Stop any in-flight speech first, deliberately.
    this.deliberateStop = true;
    void Speech.stop().catch(() => undefined);

    this.speakWithWatchdog(
      this.lastSpokenText,
      this.lastSpokenLanguage,
      this.lastSpokenRate,
      engineSegmentId,
    );
  }

  dispatch(event: EngineEvent): void {
    const result = reduce(this.state, event, Date.now(), this.config);
    this.state = result.state;
    this.notifyListeners();
    this.executeCommands(result.commands);
  }

  destroy(): void {
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.clearSpeechWatchdogs();
    this.locationAdapter?.stop();
    this.locationAdapter = null;
    // Deliberate stop on destroy.
    this.deliberateStop = true;
    void Speech.stop().catch(() => undefined);
    deactivateKeepAwake('tramio-tour').catch(() => undefined);
    void releaseTourAudioSession().catch(() => undefined);
    this.cancelAllTimers();
    this.listeners.clear();
    this.backgroundStatusListeners.clear();
    this.lastFixListeners.clear();
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
        // Deliberate stop — do not treat the resulting onStopped as a focus loss.
        this.deliberateStop = true;
        void Speech.stop().catch(() => undefined);
        break;
      case 'PauseAudio':
        // Guard: if we're already in a PauseAudio handler (from a FocusLoss
        // dispatch that itself was triggered by a non-deliberate onStopped),
        // don't call Speech.stop again — it would create a recursive loop.
        if (!this.isPausingAudio) {
          this.isPausingAudio = true;
          this.deliberateStop = true;
          void Speech.stop().catch(() => undefined);
          this.isPausingAudio = false;
        }
        break;
      case 'ResumeAudio':
        // BUG 2 FIX: Re-speak the currently-playing segment from the start.
        // The engine cannot offer mid-utterance offset for TTS.
        this.handleResumeAudio();
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
      this.narrativeResolver(segmentId) ?? 'Approaching a point of interest along your route.';
    const language = this.config?.language ?? 'en';
    // Memorial and other weighted content is delivered more slowly than
    // standard narration; the multiplier is authored per segment.
    const multiplier = this.segmentStyleResolver(segmentId)?.rateMultiplier ?? 1;
    const baseRate: number = this.playbackSpeed;
    const rate = baseRate * multiplier;

    // Track for replay (public contract).
    this.lastSpokenText = text;
    this.lastSpokenLanguage = language;
    this.lastSpokenRate = rate;

    this.currentSegmentId = segmentId;

    // Stop anything in flight to preserve the single-segment invariant.
    // This is a deliberate pre-emptive stop.
    this.deliberateStop = true;
    void Speech.stop().catch(() => undefined);

    this.speakWithWatchdog(text, language, rate, segmentId);
  }

  /**
   * Estimate how long an utterance should take, for watchdog sizing only.
   * Deliberately crude — it just needs an order-of-magnitude ceiling.
   */
  private estimateSpeechMs(text: string, rate: number): number {
    const words = text
      .trim()
      .split(/\s+/u)
      .filter((w) => w.length > 0).length;
    const safeRate = rate > 0 ? rate : 1;
    return Math.ceil((words / (WORDS_PER_SECOND * safeRate)) * 1000);
  }

  private clearSpeechWatchdogs(): void {
    if (this.speechStartTimer !== null) {
      clearTimeout(this.speechStartTimer);
      this.speechStartTimer = null;
    }
    if (this.speechDoneTimer !== null) {
      clearTimeout(this.speechDoneTimer);
      this.speechDoneTimer = null;
    }
  }

  /**
   * Speak `text`, watchdogged so the engine can never be stranded.
   *
   * `engineSegmentId` is the segment the ENGINE believes is playing. When it
   * is non-null, completion (or watchdog expiry) dispatches AudioFinished so
   * `session.playing` clears and the next POI can fire. When it is null the
   * utterance is a pure-UI replay of an already-consumed segment and must
   * not touch engine state at all.
   *
   * Watchdogs:
   *   - no onStart within SPEECH_START_TIMEOUT_MS ⇒ no TTS engine installed.
   *   - onStart but no terminal callback within ~2x the estimated duration
   *     ⇒ the engine died mid-utterance.
   * Both cases mark the POI consumed rather than leaving it to re-fire in a
   * loop while the rider is still inside the geofence, and surface a
   * SpeechStatus so the UI can tell the rider narration is broken.
   */
  private speakWithWatchdog(
    text: string,
    language: string,
    rate: number,
    engineSegmentId: string | null,
  ): void {
    this.clearSpeechWatchdogs();

    const settle = (reason: 'done' | 'error' | 'no-engine' | 'failed'): void => {
      this.clearSpeechWatchdogs();
      if (reason === 'no-engine' || reason === 'failed') {
        this.setSpeechStatus({ available: false, reason });
      }
      if (engineSegmentId === null) return;
      if (this.currentSegmentId !== engineSegmentId) return;
      this.currentSegmentId = null;
      this.dispatch({ kind: 'AudioFinished', segmentId: engineSegmentId });
    };

    this.speechStartTimer = setTimeout(() => {
      this.speechStartTimer = null;
      settle('no-engine');
    }, SPEECH_START_TIMEOUT_MS);

    Speech.speak(text, {
      language,
      rate,
      onStart: () => {
        if (this.speechStartTimer !== null) {
          clearTimeout(this.speechStartTimer);
          this.speechStartTimer = null;
        }
        this.setSpeechStatus({ available: true });
        this.speechDoneTimer = setTimeout(
          () => {
            this.speechDoneTimer = null;
            settle('failed');
          },
          this.estimateSpeechMs(text, rate) * 2 + SPEECH_DONE_GRACE_MS,
        );
      },
      onDone: () => settle('done'),
      onStopped: () => {
        this.clearSpeechWatchdogs();
        if (this.deliberateStop) {
          // We caused this stop (PauseAudio, StopAudio, replay, destroy).
          // The state change that caused it already happened.
          this.deliberateStop = false;
          return;
        }
        // OS-level interruption (phone call, Siri, another app taking audio).
        // Dispatch FocusLoss — the reducer pauses and leaves the POI
        // UNCONSUMED so it can be resumed or replayed.
        this.focusLost = true;
        this.dispatch({ kind: 'FocusLoss' });
      },
      onError: () => settle('error'),
    });

    // Invariant: starting an utterance always clears `deliberateStop`.
    this.deliberateStop = false;
  }

  private setSpeechStatus(next: SpeechStatus): void {
    if (
      this.speechStatus.available === next.available &&
      this.speechStatus.reason === next.reason
    ) {
      return;
    }
    this.speechStatus = next;
    for (const listener of this.speechStatusListeners) listener(next);
  }

  getSpeechStatus(): SpeechStatus {
    return this.speechStatus;
  }

  subscribeSpeechStatus(listener: SpeechStatusListener): () => void {
    this.speechStatusListeners.add(listener);
    return () => {
      this.speechStatusListeners.delete(listener);
    };
  }

  /**
   * Probe for a usable TTS voice before the first POI fires, so the rider
   * learns narration is unavailable at the route screen rather than by
   * hearing nothing for twenty minutes.
   */
  private async probeSpeechAvailability(language: string): Promise<void> {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      if (voices.length === 0) {
        this.setSpeechStatus({ available: false, reason: 'no-engine' });
        return;
      }
      const base = language.toLowerCase().split(/[-_]/u)[0] ?? language.toLowerCase();
      const match = voices.some((v) => v.language.toLowerCase().startsWith(base));
      this.setSpeechStatus(
        match ? { available: true } : { available: false, reason: 'no-voice-for-language' },
      );
    } catch {
      // A throwing voice query is itself evidence of a broken engine, but we
      // do not block the tour on it — the per-utterance watchdog still covers us.
      this.setSpeechStatus({ available: false, reason: 'no-engine' });
    }
  }

  private handleResumeAudio(): void {
    // Re-speak the currently-playing segment from the start. expo-speech has
    // no seek/resume, so restarting the segment is the only option; this is
    // why segments are authored short (and why pre-rendered audio is the real
    // fix — see HANDOFF next-step 7).
    const playing = this.getPlayingSegment();
    if (!playing) return;

    const segmentId = playing.segmentId;
    const text =
      this.narrativeResolver(segmentId) ?? 'Approaching a point of interest along your route.';
    const language = this.config?.language ?? 'en';
    const multiplier = this.segmentStyleResolver(segmentId)?.rateMultiplier ?? 1;
    const rate = (this.playbackSpeed as number) * multiplier;

    this.currentSegmentId = segmentId;
    this.speakWithWatchdog(text, language, rate, segmentId);
  }

  private getPlayingSegment(): { segmentId: string; poiId: string } | null {
    const s = this.state;
    if (
      s.phase === 'Active' ||
      s.phase === 'Standby' ||
      s.phase === 'DeadReckoning' ||
      s.phase === 'Deviation'
    ) {
      return s.session.playing ?? null;
    }
    return null;
  }

  private handleReleaseAll(): void {
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.locationAdapter?.stop();
    this.locationAdapter = null;
    this.deliberateStop = true;
    void Speech.stop().catch(() => undefined);
    deactivateKeepAwake('tramio-tour').catch(() => undefined);
    void releaseTourAudioSession().catch(() => undefined);
    // Reset per-tour state.
    this.lastFixAtMs = null;
    this.notifyLastFix();
    this.backgroundStatus = { mode: 'foreground-only', reason: 'unavailable' };
    this.notifyBackgroundStatus();
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

  private notifyBackgroundStatus(): void {
    for (const listener of this.backgroundStatusListeners) listener(this.backgroundStatus);
  }

  private notifyLastFix(): void {
    for (const listener of this.lastFixListeners) listener(this.lastFixAtMs);
  }
}
