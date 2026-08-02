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
import { INITIAL_STATE, reduce, projectOnRoute } from '../../../engine/src';
import { LocationAdapter, type LocationDeliveryStatus } from './locationAdapter';
import { DEFAULT_PLAYBACK_SPEED, type PlaybackSpeed } from './playbackSpeed';
import { configureTourAudioSession, releaseTourAudioSession } from './audioSession';
import type { AudioPlaybackPort, AudioPlaybackCallbacks } from './AudioPlaybackPort';
import { FieldDiagnosticsRecorder } from './fieldDiagnostics';
import { createDeskDebugSession, IS_DESK_DEBUG, type DeskDebugSession } from './deskDebug';

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
  /**
   * Injectable audio playback port for pre-rendered audio files.
   * When absent, pre-rendered audio commands trigger a TTS fallback.
   */
  audioPort?: AudioPlaybackPort;
}

/** Background status exposed to the UI for a "no background" warning. */
export interface BackgroundStatus {
  mode: 'background' | 'foreground-only';
  reason?: string;
}

export type BackgroundStatusListener = (status: BackgroundStatus) => void;
export type LastFixListener = (ms: number | null) => void;
export type LocationDeliveryStatusListener = (status: LocationDeliveryStatus) => void;

export type { LocationDeliveryStatus };

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

export interface StartTourRuntimeOptions {
  /**
   * Desk testing on a physical device (`__DEV__` only). Ignored in production.
   */
  readonly deskGpsReplay?: boolean;
  /** Wall-clock speed for desk replay (default 4). */
  readonly deskReplaySpeedMultiplier?: number;
  /** How many leading POIs to include in the desk trace (default 8). */
  readonly deskReplayPoiCount?: number;
}

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
  // AppState subscription for FocusRegain + keep-awake policy.
  private appStateSubscription: NativeEventSubscription | null = null;
  private deskDebug: DeskDebugSession | null = null;
  private deskReplayComplete = false;
  private tourKeepAwakeActive = false;
  private deskReplaySpeed = 21;
  private deskReplaySpeedListeners = new Set<(speed: number) => void>();
  private deskReplayCompleteListeners = new Set<(complete: boolean) => void>();
  /** Consecutive accuracy rejects since last accept — drives poorAccuracy banner. */
  private accuracyRejectStreak = 0;
  private poorAccuracy = false;
  private poorAccuracyListeners = new Set<(poor: boolean) => void>();

  // ─── PUBLIC CONTRACT: replay, background status, last fix ─────────
  private lastSpokenText: string | null = null;
  private lastSpokenLanguage = 'en';
  private lastSpokenRate = 1.0;
  /**
   * The source type of the last/current playback. 'audio' = pre-rendered,
   * 'tts' = device speech. Used for replay dispatch and UI exposure.
   */
  private lastSource: 'audio' | 'tts' = 'tts';
  private lastAudioAssetPath: string | null = null;
  /**
   * The actual language used for the current/last playback. May differ from
   * config.language when the audio source selection chain falls back to the
   * default language or another available language.
   */
  private lastPlaybackLanguage = 'en';

  /** Injectable audio port for pre-rendered file playback. */
  private audioPort: AudioPlaybackPort | null = null;
  /** Whether the currently-active playback source is pre-rendered audio. */
  private activeSourceIsAudio = false;
  /**
   * Monotonically increasing generation counter for audio port callbacks.
   * Incremented on every new play/stop/replay so that stale callbacks from
   * a previous play session are suppressed even when the segmentId matches.
   */
  private audioPlayGeneration = 0;

  private backgroundStatus: BackgroundStatus = { mode: 'foreground-only', reason: 'unavailable' };
  private backgroundStatusListeners = new Set<BackgroundStatusListener>();

  private lastFixAtMs: number | null = null;
  private lastFixListeners = new Set<LastFixListener>();

  // ─── Wave 4: Delivery status + diagnostics ─────────────────────────
  private locationDeliveryStatus: LocationDeliveryStatus = 'acquiring';
  private locationDeliveryStatusListeners = new Set<LocationDeliveryStatusListener>();
  private diagnosticsRecorder: FieldDiagnosticsRecorder | null = null;
  private finalDiagnosticsReport: string | null = null;

  // ─── Speech watchdog (missing-TTS-engine detection) ────────────────
  private speechStartTimer: ReturnType<typeof setTimeout> | null = null;
  private speechDoneTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStatus: SpeechStatus = { available: true };
  private speechStatusListeners = new Set<SpeechStatusListener>();

  constructor(opts?: TourRuntimeOptions) {
    this.narrativeResolver = opts?.narrativeResolver ?? (() => null);
    this.segmentStyleResolver = opts?.segmentStyleResolver ?? (() => null);
    this.audioPort = opts?.audioPort ?? null;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Start a tour. Begins watching location and dispatches start. */
  start(config: StartTourConfig, options?: StartTourRuntimeOptions): void {
    this.config = config;

    // BUG 1 FIX: activate the audio session for background + silent-mode playback.
    void configureTourAudioSession().catch(() => undefined);

    this.syncKeepAwake(AppState.currentState === 'active');

    // Reset per-tour state.
    this.lastFixAtMs = null;
    this.notifyLastFix();
    this.focusLost = false;
    this.deliberateStop = false;
    this.clearSpeechWatchdogs();
    this.speechStatus = { available: true };
    this.stopDeskDebug();
    this.accuracyRejectStreak = 0;
    this.setPoorAccuracy(false);
    this.deskReplaySpeed = options?.deskReplaySpeedMultiplier ?? 21;
    this.setDeskReplayComplete(false);
    for (const listener of this.deskReplaySpeedListeners) listener(this.deskReplaySpeed);

    // Wave 4: Initialize diagnostics recorder for this tour.
    this.diagnosticsRecorder = new FieldDiagnosticsRecorder();
    this.finalDiagnosticsReport = null;
    this.locationDeliveryStatus = 'acquiring';
    for (const listener of this.locationDeliveryStatusListeners) listener('acquiring');

    // Probe for a usable TTS voice up front. A device with no TTS engine
    // installed would otherwise fail silently on the first POI.
    void this.probeSpeechAvailability(config.language);

    // Subscribe to AppState for FocusRegain + keep-awake (screen on only).
    this.appStateSubscription?.remove();
    this.appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && this.focusLost) {
        this.focusLost = false;
        this.dispatch({ kind: 'FocusRegain' });
      }
      // Keep-awake only while foregrounded — pocket rides must not pin the CPU.
      this.syncKeepAwake(nextState === 'active');
      if (nextState === 'active') {
        this.locationAdapter?.requestImmediateRecovery();
      }
    });

    // Desk GPS inject is __DEV__-only; production builds never enter replay mode.
    const deskReplay = IS_DESK_DEBUG && options?.deskGpsReplay === true;

    this.locationAdapter = new LocationAdapter(config.route, config.geofences, {
      onAccepted: (update) => {
        this.lastFixAtMs = Date.now();
        this.notifyLastFix();
        this.diagnosticsRecorder?.recordAccepted();
        this.setPoorAccuracy(false);
        this.accuracyRejectStreak = 0;
        this.dispatch({ kind: 'LocationAccepted', update });
      },
      onGeofenceDwell: (poiId) => {
        this.diagnosticsRecorder?.recordGeofenceFire();
        this.dispatch({ kind: 'GeofenceDwell', poiId });
      },
      onPermissionDenied: () => {
        // Without location we cannot run a tour; end it cleanly.
        this.dispatch({ kind: 'UserCommand', cmd: 'end' });
      },
      onDelivered: (meta) => {
        this.diagnosticsRecorder?.recordDelivery(meta.accuracyM);
      },
      onRejected: (meta) => {
        this.diagnosticsRecorder?.recordRejected(meta.reason);
        if (meta.reason === 'accuracy') {
          this.accuracyRejectStreak += 1;
          if (this.accuracyRejectStreak >= 3) this.setPoorAccuracy(true);
        }
      },
    });

    // Wire background status reporting from the adapter.
    this.locationAdapter.onBackgroundStatusChange = (status) => {
      this.backgroundStatus = status;
      if (status.mode === 'foreground-only' && status.reason !== undefined) {
        this.diagnosticsRecorder?.recordChannelTransition('foreground_only_degraded');
      }
      this.notifyBackgroundStatus();
    };

    // Wave 4: Wire delivery status.
    this.locationAdapter.subscribeDeliveryStatus((status) => {
      this.locationDeliveryStatus = status;
      if (status === 'recovering') this.diagnosticsRecorder?.recordStallDetected();
      this.diagnosticsRecorder?.recordDeliveryStatus(status);
      for (const listener of this.locationDeliveryStatusListeners) listener(status);
    });

    // Wave 4: Wire diagnostics callbacks.
    this.locationAdapter.onRecoveryAttempt = () => {
      this.diagnosticsRecorder?.recordRecoveryAttempt();
    };
    this.locationAdapter.onRecoverySuccess = () => {
      this.diagnosticsRecorder?.recordRecoverySuccess();
    };
    this.locationAdapter.onRecoveryFailure = () => {
      this.diagnosticsRecorder?.recordRecoveryFailure();
    };
    this.locationAdapter.onChannelChange = (channel) => {
      if (channel === 'foreground' || channel === 'replay') {
        this.diagnosticsRecorder?.recordChannelTransition('foreground');
      } else {
        this.diagnosticsRecorder?.recordChannelTransition('background');
      }
    };

    void this.locationAdapter
      .start(deskReplay ? { source: 'replay' } : { source: 'live' })
      .then(() => {
        if (deskReplay) {
          this.beginDeskDebug(options);
        }
      })
      .catch(() => {
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

  getPoorAccuracy(): boolean {
    return this.poorAccuracy;
  }

  subscribePoorAccuracy(listener: (poor: boolean) => void): () => void {
    this.poorAccuracyListeners.add(listener);
    return () => {
      this.poorAccuracyListeners.delete(listener);
    };
  }

  isDeskGpsReplayActive(): boolean {
    return IS_DESK_DEBUG && this.deskDebug?.isActive() === true;
  }

  isDeskReplayComplete(): boolean {
    return this.deskReplayComplete;
  }

  getDeskReplaySpeed(): number {
    return this.deskReplaySpeed;
  }

  subscribeDeskReplaySpeed(listener: (speed: number) => void): () => void {
    this.deskReplaySpeedListeners.add(listener);
    return () => {
      this.deskReplaySpeedListeners.delete(listener);
    };
  }

  subscribeDeskReplayComplete(listener: (complete: boolean) => void): () => void {
    this.deskReplayCompleteListeners.add(listener);
    return () => {
      this.deskReplayCompleteListeners.delete(listener);
    };
  }

  /** `__DEV__` desk control: change GPS trace speed in km/h. */
  setDeskReplaySpeed(speedKmh: number): void {
    if (!IS_DESK_DEBUG) return;
    const next = Math.max(5, Math.min(300, speedKmh));
    this.deskReplaySpeed = next;
    this.deskDebug?.setTripSpeed(next);
    for (const listener of this.deskReplaySpeedListeners) listener(next);
  }

  /**
   * `__DEV__` control: skip ahead to the next unconsumed POI and play it now.
   *
   * Seeks the desk GPS cursor, snaps the rider on the map, and fires the POI
   * without waiting on dwell. No-op in production.
   */
  debugTriggerNextPoi(): void {
    if (!IS_DESK_DEBUG) return;
    if (this.deskDebug?.isActive()) {
      this.deskDebug.skipToNextPoi();
      this.setDeskReplayComplete(this.deskDebug.isReplayComplete());
      return;
    }
    // Fallback when desk session is not running (e.g. live GPS + Next POI).
    if (!this.config) return;
    const playing = this.getPlayingSegment();
    if (playing) {
      this.stopAllPlayback();
      this.dispatch({ kind: 'AudioFinished', segmentId: playing.segmentId });
    }
    const session =
      this.state.phase === 'Active' ||
      this.state.phase === 'Standby' ||
      this.state.phase === 'DeadReckoning' ||
      this.state.phase === 'Deviation'
        ? this.state.session
        : null;
    if (!session) return;
    const currentAlongRouteM = session.lastAccepted?.alongRouteM ?? 0;
    const next = this.config.geofences.find((g) => {
      if (g.geometry.kind !== 'circle') return false;
      const proj = projectOnRoute(this.config!.route, g.geometry.center);
      return proj.alongRouteM > currentAlongRouteM + 5 && !session.consumed.has(g.poiId);
    });
    if (!next) return;
    this.dispatch({ kind: 'GeofenceDwell', poiId: next.poiId });
  }

  getBackgroundStatus(): BackgroundStatus {
    return this.backgroundStatus;
  }

  getLastFixAtMs(): number | null {
    return this.lastFixAtMs;
  }

  // ─── Wave 4: Delivery status & diagnostics public API ───────────────

  getLocationDeliveryStatus(): LocationDeliveryStatus {
    return this.locationDeliveryStatus;
  }

  subscribeLocationDeliveryStatus(listener: LocationDeliveryStatusListener): () => void {
    this.locationDeliveryStatusListeners.add(listener);
    return () => {
      this.locationDeliveryStatusListeners.delete(listener);
    };
  }

  /**
   * Get the field diagnostics report. Available during and after the tour.
   * After tour end, the finalized report remains accessible.
   */
  getFieldDiagnosticsReport(): string | null {
    if (this.finalDiagnosticsReport) return this.finalDiagnosticsReport;
    return this.diagnosticsRecorder?.exportReport() ?? null;
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
    if (this.lastSpokenText === null && this.lastAudioAssetPath === null) return;

    const playing = this.getPlayingSegment();
    const engineSegmentId = playing ? playing.segmentId : null;

    if (engineSegmentId !== null) {
      this.currentSegmentId = engineSegmentId;
    }

    // Stop any in-flight playback first, deliberately.
    this.stopAllPlayback();

    if (this.lastSource === 'audio' && this.audioPort && this.lastAudioAssetPath) {
      // Replay pre-rendered audio.
      this.activeSourceIsAudio = true;
      const assetPath = this.lastAudioAssetPath;
      const gen = this.audioPlayGeneration;
      const callbacks: AudioPlaybackCallbacks = {
        onComplete: () => {
          if (this.audioPlayGeneration !== gen) return;
          if (engineSegmentId === null) return;
          if (this.currentSegmentId !== engineSegmentId) return;
          this.currentSegmentId = null;
          this.activeSourceIsAudio = false;
          this.dispatch({ kind: 'AudioFinished', segmentId: engineSegmentId });
        },
        onError: () => {
          if (this.audioPlayGeneration !== gen) return;
          // Release the failed player before starting a second source.
          this.audioPort!.stop();
          this.activeSourceIsAudio = false;
          // On replay error, fall back to TTS replay if possible.
          if (this.lastSpokenText) {
            this.lastSource = 'tts';
            this.speakWithWatchdog(
              this.lastSpokenText,
              this.lastSpokenLanguage,
              this.lastSpokenRate,
              engineSegmentId,
            );
          } else if (engineSegmentId !== null) {
            if (this.currentSegmentId !== engineSegmentId) return;
            this.currentSegmentId = null;
            this.dispatch({ kind: 'AudioFinished', segmentId: engineSegmentId });
          }
        },
      };
      this.audioPort.play(assetPath, callbacks);
    } else if (this.lastSpokenText !== null) {
      // Replay via TTS.
      this.activeSourceIsAudio = false;
      this.speakWithWatchdog(
        this.lastSpokenText,
        this.lastSpokenLanguage,
        this.lastSpokenRate,
        engineSegmentId,
      );
    }
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
    this.stopDeskDebug();
    this.locationAdapter?.stop();
    this.locationAdapter = null;
    // Stop all playback and release audio port.
    this.stopAllPlayback();
    if (this.audioPort) {
      this.audioPort.release();
    }
    this.syncKeepAwake(false);
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
        this.handlePlaySegment(cmd);
        break;
      case 'StopAudio':
        // Deliberate stop — do not treat the resulting onStopped as a focus loss.
        this.stopAllPlayback();
        break;
      case 'PauseAudio':
        // Guard: if we're already in a PauseAudio handler (from a FocusLoss
        // dispatch that itself was triggered by a non-deliberate onStopped),
        // don't call Speech.stop again — it would create a recursive loop.
        if (!this.isPausingAudio) {
          this.isPausingAudio = true;
          if (this.activeSourceIsAudio && this.audioPort) {
            this.audioPort.pause();
          } else {
            this.deliberateStop = true;
            void Speech.stop().catch(() => undefined);
          }
          this.isPausingAudio = false;
        }
        break;
      case 'ResumeAudio':
        // BUG 2 FIX: Re-speak the currently-playing segment from the start.
        // The engine cannot offer mid-utterance offset for TTS.
        // For pre-rendered audio: resume from paused offset.
        this.handleResumeAudio();
        break;
      case 'RequestLocationMode':
        this.locationAdapter?.setEngineMode(cmd.mode);
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

  private handlePlaySegment(cmd: Extract<EngineCommand, { kind: 'PlaySegment' }>): void {
    const { segmentId, source, language, assetPath } = cmd;

    // Stop any in-flight source to preserve the single-segment invariant.
    this.stopAllPlayback();

    this.currentSegmentId = segmentId;

    if (source === 'audio' && this.audioPort) {
      // ─── Pre-rendered audio path ────────────────────────────────────
      this.activeSourceIsAudio = true;
      this.lastSource = 'audio';
      this.lastAudioAssetPath = assetPath;
      this.lastPlaybackLanguage = language;
      // Preserve TTS replay data in case audio fails and we fallback.
      const text = this.narrativeResolver(segmentId);
      if (text) {
        this.lastSpokenText = text;
        this.lastSpokenLanguage = language;
        const multiplier = this.segmentStyleResolver(segmentId)?.rateMultiplier ?? 1;
        this.lastSpokenRate = (this.playbackSpeed as number) * multiplier;
      }

      const gen = this.audioPlayGeneration;
      const callbacks: AudioPlaybackCallbacks = {
        onStart: () => {
          // Optional: could notify UI.
        },
        onComplete: () => {
          if (this.audioPlayGeneration !== gen) return;
          if (this.currentSegmentId !== segmentId) return;
          this.currentSegmentId = null;
          this.activeSourceIsAudio = false;
          this.dispatch({ kind: 'AudioFinished', segmentId });
        },
        onError: (_msg: string) => {
          if (this.audioPlayGeneration !== gen) return;
          if (this.currentSegmentId !== segmentId) return;
          // Stop the port to release native resources/listeners before fallback.
          this.audioPort!.stop();
          this.activeSourceIsAudio = false;
          // Fallback: try TTS for the same segment if narrative is available.
          const fallbackText = this.narrativeResolver(segmentId);
          if (fallbackText) {
            this.lastSource = 'tts';
            this.lastPlaybackLanguage = language;
            const multiplier = this.segmentStyleResolver(segmentId)?.rateMultiplier ?? 1;
            const rate = (this.playbackSpeed as number) * multiplier;
            this.lastSpokenText = fallbackText;
            this.lastSpokenLanguage = language;
            this.lastSpokenRate = rate;
            this.speakWithWatchdog(fallbackText, language, rate, segmentId);
          } else {
            // No TTS fallback available — advance the engine safely.
            this.currentSegmentId = null;
            this.setSpeechStatus({ available: false, reason: 'failed' });
            this.dispatch({ kind: 'AudioFinished', segmentId });
          }
        },
      };

      this.audioPort.play(assetPath, callbacks);
    } else if (source === 'audio' && !this.audioPort) {
      // ─── Audio source requested but no port available ───────────────
      // Fallback to matching narrative via TTS if available. Do NOT use
      // generic text — only speak verified narrative content for packs.
      this.activeSourceIsAudio = false;
      const text = this.narrativeResolver(segmentId);
      if (text) {
        this.lastSource = 'tts';
        this.lastAudioAssetPath = null;
        this.lastPlaybackLanguage = language;
        const multiplier = this.segmentStyleResolver(segmentId)?.rateMultiplier ?? 1;
        const baseRate: number = this.playbackSpeed;
        const rate = baseRate * multiplier;
        this.lastSpokenText = text;
        this.lastSpokenLanguage = language;
        this.lastSpokenRate = rate;
        this.speakWithWatchdog(text, language, rate, segmentId);
      } else {
        // No narrative available either — safely advance.
        this.currentSegmentId = null;
        this.setSpeechStatus({ available: false, reason: 'failed' });
        this.dispatch({ kind: 'AudioFinished', segmentId });
      }
    } else {
      // ─── TTS path (legacy/demo embedded tours) ──────────────────────
      this.activeSourceIsAudio = false;
      this.lastSource = 'tts';
      this.lastAudioAssetPath = null;
      this.lastPlaybackLanguage = language;

      const text =
        this.narrativeResolver(segmentId) ?? 'Approaching a point of interest along your route.';
      const multiplier = this.segmentStyleResolver(segmentId)?.rateMultiplier ?? 1;
      const baseRate: number = this.playbackSpeed;
      const rate = baseRate * multiplier;

      // Track for replay (public contract).
      this.lastSpokenText = text;
      this.lastSpokenLanguage = language;
      this.lastSpokenRate = rate;

      this.speakWithWatchdog(text, language, rate, segmentId);
    }
  }

  /**
   * Stop all active playback sources (both audio port and TTS).
   * Used to enforce single-segment invariant and for clean teardown.
   */
  private stopAllPlayback(): void {
    // Increment generation to invalidate any pending audio callbacks.
    this.audioPlayGeneration++;
    // Stop pre-rendered audio player if active.
    if (this.activeSourceIsAudio && this.audioPort) {
      this.audioPort.stop();
      this.activeSourceIsAudio = false;
    }
    // Stop TTS.
    this.deliberateStop = true;
    void Speech.stop().catch(() => undefined);
    this.clearSpeechWatchdogs();
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

  /**
   * Whether the current or last segment used pre-rendered audio or TTS.
   * Returns 'audio' when playing a verified pack file, 'tts' when using
   * device speech synthesis.
   */
  getActiveSource(): 'audio' | 'tts' {
    return this.lastSource;
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
    // For pre-rendered audio: resume from paused offset (no restart needed).
    if (this.activeSourceIsAudio && this.audioPort) {
      this.audioPort.resume();
      return;
    }
    // For TTS: Re-speak the currently-playing segment from the start.
    // expo-speech has no seek/resume, so restarting the segment is the
    // only option.
    const playing = this.getPlayingSegment();
    if (!playing) return;

    const segmentId = playing.segmentId;
    const text =
      this.narrativeResolver(segmentId) ?? 'Approaching a point of interest along your route.';
    // Use the actual language selected by source resolution/fallback, not
    // blindly config.language, so resumed TTS matches the original segment.
    const language = this.lastPlaybackLanguage;
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
    this.stopDeskDebug();
    this.locationAdapter?.stop();
    this.locationAdapter = null;
    // Stop all playback sources.
    this.stopAllPlayback();
    this.syncKeepAwake(false);
    void releaseTourAudioSession().catch(() => undefined);
    // Wave 4: Finalize diagnostics — report remains available after Ended.
    if (this.diagnosticsRecorder) {
      this.diagnosticsRecorder.finalize();
      this.finalDiagnosticsReport = this.diagnosticsRecorder.exportReport();
    }
    // Reset per-tour state.
    this.lastFixAtMs = null;
    this.notifyLastFix();
    this.backgroundStatus = { mode: 'foreground-only', reason: 'unavailable' };
    this.notifyBackgroundStatus();
  }

  private syncKeepAwake(wantActive: boolean): void {
    if (wantActive) {
      if (this.tourKeepAwakeActive) return;
      this.tourKeepAwakeActive = true;
      void activateKeepAwakeAsync('tramio-tour').catch(() => {
        this.tourKeepAwakeActive = false;
      });
      return;
    }
    if (!this.tourKeepAwakeActive) {
      deactivateKeepAwake('tramio-tour').catch(() => undefined);
      return;
    }
    this.tourKeepAwakeActive = false;
    deactivateKeepAwake('tramio-tour').catch(() => undefined);
  }

  private stopDeskDebug(): void {
    this.deskDebug?.stop();
    this.deskDebug = null;
    this.setDeskReplayComplete(false);
  }

  private setDeskReplayComplete(complete: boolean): void {
    if (this.deskReplayComplete === complete) return;
    this.deskReplayComplete = complete;
    for (const listener of this.deskReplayCompleteListeners) listener(complete);
  }

  private setPoorAccuracy(poor: boolean): void {
    if (this.poorAccuracy === poor) return;
    this.poorAccuracy = poor;
    for (const listener of this.poorAccuracyListeners) listener(poor);
  }

  private beginDeskDebug(options?: StartTourRuntimeOptions): void {
    if (!IS_DESK_DEBUG) return;
    if (!this.locationAdapter || this.locationAdapter.getLocationSource() !== 'replay') return;

    const adapter = this.locationAdapter;
    this.deskDebug = createDeskDebugSession({
      injectFix: (loc) => adapter.feedReplayFix(loc as never),
      resyncPipelineAt: (coord, accuracyM) => adapter.resyncPipelineAt(coord, accuracyM),
      acceptPosition: (update) => {
        this.lastFixAtMs = Date.now();
        this.notifyLastFix();
        this.dispatch({ kind: 'LocationAccepted', update });
      },
      finishPlayingSegment: (segmentId) => {
        this.stopAllPlayback();
        this.dispatch({ kind: 'AudioFinished', segmentId });
      },
      stopPlayback: () => this.stopAllPlayback(),
      triggerPoi: (poiId) => this.dispatch({ kind: 'GeofenceDwell', poiId }),
      getPlayingSegmentId: () => this.getPlayingSegment()?.segmentId ?? null,
      getConsumed: () => {
        const s =
          this.state.phase === 'Active' ||
          this.state.phase === 'Standby' ||
          this.state.phase === 'DeadReckoning' ||
          this.state.phase === 'Deviation'
            ? this.state.session
            : null;
        return s?.consumed ?? new Set();
      },
      getAlongRouteM: () => {
        const s =
          this.state.phase === 'Active' ||
          this.state.phase === 'Standby' ||
          this.state.phase === 'DeadReckoning' ||
          this.state.phase === 'Deviation'
            ? this.state.session
            : null;
        return s?.lastAccepted?.alongRouteM ?? 0;
      },
      getConfig: () => this.config,
      onTripSpeedChange: (mult) => {
        this.deskReplaySpeed = mult;
        for (const listener of this.deskReplaySpeedListeners) listener(mult);
      },
      onReplayComplete: () => this.setDeskReplayComplete(true),
      noteFixWallClock: () => {
        // Raw delivery may still be spike-rejected; keep UI GPS-liveness warm
        // from the replay pump itself.
        this.lastFixAtMs = Date.now();
        this.notifyLastFix();
      },
    });

    const speed = options?.deskReplaySpeedMultiplier ?? this.deskReplaySpeed;
    this.deskReplaySpeed = speed;
    this.deskDebug?.start({
      speedMultiplier: speed,
      ...(options?.deskReplayPoiCount != null ? { poiCount: options.deskReplayPoiCount } : {}),
    });
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
