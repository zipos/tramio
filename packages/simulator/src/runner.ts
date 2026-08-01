/**
 * Deterministic simulation runner.
 *
 * Feeds trace events through the REAL production geofence pipeline and
 * Tour_Engine reducer. Does NOT duplicate any engine logic — it uses the
 * imported `step` and `reduce` functions directly.
 *
 * The runner models:
 * - Narration duration from word count / speaking rate
 * - Deterministic timer execution (ScheduleTimer → Timer event at scheduled time)
 * - Audio completion events (PlaySegment → AudioFinished after computed duration)
 * - Fault injection (TTS unavailable, audio interrupts)
 *
 * All ordering is deterministic: pending timers and audio completions are
 * resolved in timestamp order, ties broken by insertion order.
 *
 * @module
 */

import type {
  EngineCommand,
  EngineEvent,
  PipelineOutput,
  PipelineState,
  StartTourConfig,
  TourState,
} from '../../engine/src';
import { INITIAL_STATE, initialPipelineState, isRejected, reduce, step } from '../../engine/src';
import type { TraceEvent } from './trace';

// ─── Narrative duration model ───────────────────────────────────────────────

/** Default speaking rate in words per minute (normal TTS pace). */
const DEFAULT_WPM = 150;
/** Memorial speaking rate multiplier. */
const MEMORIAL_RATE_MULTIPLIER = 0.9;

export interface NarrativeMeta {
  readonly text: string;
  readonly wordCount: number;
  /** Whether this is a memorial-register segment. */
  readonly isMemorial: boolean;
}

/**
 * Compute narration duration in ms from word count and rate.
 *
 * @param wordCount - Number of words in the segment.
 * @param wpm - Words per minute rate (default 150).
 * @param rateMultiplier - Multiplier for memorial content (0.9 = slower).
 */
export function computeNarrationDurationMs(
  wordCount: number,
  wpm: number = DEFAULT_WPM,
  rateMultiplier: number = 1,
): number {
  const effectiveWpm = wpm * rateMultiplier;
  return Math.round((wordCount / effectiveWpm) * 60 * 1000);
}

// ─── Pending action queue ───────────────────────────────────────────────────

interface PendingTimer {
  readonly kind: 'timer';
  readonly id: string;
  readonly firesAtMs: number;
  readonly insertionOrder: number;
}

interface PendingAudioCompletion {
  readonly kind: 'audio';
  readonly segmentId: string;
  readonly completesAtMs: number;
  /** Present only while playback is paused; paused actions are not drainable. */
  readonly pausedRemainingMs?: number;
  readonly insertionOrder: number;
}

type PendingAction = PendingTimer | PendingAudioCompletion;

// ─── Timeline entry (output) ────────────────────────────────────────────────

export interface TimelineEntry {
  readonly atMs: number;
  readonly kind:
    | 'fix_accepted'
    | 'fix_rejected'
    | 'poi_fired'
    | 'command'
    | 'timer_fired'
    | 'audio_finished'
    | 'state_change'
    | 'focus_loss'
    | 'focus_regain'
    | 'tour_start'
    | 'tour_end'
    | 'fault';
  readonly detail: string;
}

// ─── Simulation report ──────────────────────────────────────────────────────

export interface SimulationReport {
  /** Total simulation wall-clock duration in ms. */
  readonly durationMs: number;
  /** Number of GPS fixes accepted. */
  readonly acceptedFixes: number;
  /** Number of GPS fixes rejected (with reasons). */
  readonly rejectedFixes: number;
  readonly rejectionReasons: Readonly<Record<string, number>>;
  /** POI IDs that fired in order. */
  readonly firedPois: readonly string[];
  /** POI IDs consumed (should equal firedPois for successful runs). */
  readonly consumedPois: readonly string[];
  /** Commands emitted by the reducer. */
  readonly commandsEmitted: readonly EngineCommand[];
  /** Whether any segment was stuck in 'playing' at end. */
  readonly stuckPlaying: boolean;
  /** Pending timers that never fired. */
  readonly pendingTimersAtEnd: readonly string[];
  /** Warnings and errors. */
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
  /** Full timeline for human inspection. */
  readonly timeline: readonly TimelineEntry[];
  /** Final engine state phase. */
  readonly finalPhase: string;
  /** Per-POI trigger details. */
  readonly triggerDetails: readonly TriggerDetail[];
}

export interface TriggerDetail {
  readonly poiId: string;
  /** Wall-clock ms when the POI dwell condition was met. */
  readonly firedAtMs: number;
  /** Wall-clock ms when audio finished for this POI. */
  readonly finishedAtMs: number | null;
  /** Narration duration in ms. */
  readonly narrationDurationMs: number;
  /** Trigger latency: time from entering the geofence to firing (if derivable). */
  readonly triggerLatencyMs: number | null;
}

// ─── Runner configuration ───────────────────────────────────────────────────

export interface RunnerConfig {
  /** Engine tour start config. */
  readonly tourConfig: StartTourConfig;
  /** Narrative text resolver: segmentId → text (null if missing). */
  readonly narrativeResolver: (segmentId: string) => string | null;
  /** Memorial POI IDs for rate adjustment. */
  readonly memorialPoiIds: readonly string[];
  /** Words-per-minute for TTS duration modeling (default: 150). */
  readonly wpm?: number;
  /** Whether TTS is initially available (default: true). */
  readonly ttsAvailable?: boolean;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

/**
 * Run a deterministic simulation of a trace through the production engine.
 *
 * This is the heart of the simulator. It feeds every trace event through
 * the real pipeline `step()` and `reduce()` functions, resolves pending
 * timers and audio completions in deterministic order, and produces a
 * machine-readable report.
 */
export function runSimulation(
  trace: readonly TraceEvent[],
  config: RunnerConfig,
): SimulationReport {
  const wpm = config.wpm ?? DEFAULT_WPM;
  let ttsAvailable = config.ttsAvailable ?? true;

  let engineState: TourState = INITIAL_STATE;
  let pipelineState: PipelineState | null = null;
  let tourStarted = false;

  const pendingActions: PendingAction[] = [];
  let insertionCounter = 0;

  const timeline: TimelineEntry[] = [];
  const firedPois: string[] = [];
  const consumedPois: string[] = [];
  const commandsEmitted: EngineCommand[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const triggerDetails: TriggerDetail[] = [];
  const rejectionReasons: Record<string, number> = {};

  let acceptedFixes = 0;
  let rejectedFixes = 0;
  let startMs = 0;
  let lastMs = 0;

  // Track geofence entry times for latency calculation
  const geofenceEntryTimes: Map<string, number> = new Map();

  function scheduleTimer(id: string, afterMs: number, now: number): void {
    pendingActions.push({
      kind: 'timer',
      id,
      firesAtMs: now + afterMs,
      insertionOrder: insertionCounter++,
    });
  }

  function cancelTimer(id: string): void {
    const idx = pendingActions.findIndex((a) => a.kind === 'timer' && a.id === id);
    if (idx >= 0) pendingActions.splice(idx, 1);
  }

  function scheduleAudioCompletion(segmentId: string, durationMs: number, now: number): void {
    pendingActions.push({
      kind: 'audio',
      segmentId,
      completesAtMs: now + durationMs,
      insertionOrder: insertionCounter++,
    });
  }

  function cancelAudio(): void {
    for (let i = pendingActions.length - 1; i >= 0; i--) {
      if (pendingActions[i]?.kind === 'audio') pendingActions.splice(i, 1);
    }
  }

  function pauseAudio(now: number): void {
    const idx = pendingActions.findIndex(
      (action) => action.kind === 'audio' && action.pausedRemainingMs === undefined,
    );
    if (idx < 0) return;
    const action = pendingActions[idx];
    if (!action || action.kind !== 'audio') return;
    pendingActions[idx] = {
      ...action,
      pausedRemainingMs: Math.max(0, action.completesAtMs - now),
    };
  }

  function resumeAudio(now: number): void {
    const idx = pendingActions.findIndex(
      (action) => action.kind === 'audio' && action.pausedRemainingMs !== undefined,
    );
    if (idx < 0) return;
    const action = pendingActions[idx];
    if (!action || action.kind !== 'audio' || action.pausedRemainingMs === undefined) return;
    pendingActions[idx] = {
      kind: 'audio',
      segmentId: action.segmentId,
      completesAtMs: now + action.pausedRemainingMs,
      insertionOrder: insertionCounter++,
    };
  }

  function processCommands(commands: readonly EngineCommand[], now: number): void {
    for (const cmd of commands) {
      commandsEmitted.push(cmd);
      timeline.push({ atMs: now, kind: 'command', detail: formatCommand(cmd) });

      switch (cmd.kind) {
        case 'ScheduleTimer':
          scheduleTimer(cmd.id, cmd.afterMs, now);
          break;
        case 'CancelTimer':
          cancelTimer(cmd.id);
          break;
        case 'PlaySegment': {
          if (!ttsAvailable) {
            warnings.push(
              `TTS unavailable when PlaySegment(${cmd.segmentId}) requested at ${now}ms`,
            );
            // Even without TTS, the engine thinks it's playing. Emit AudioFinished immediately
            // so the engine doesn't get stuck.
            scheduleAudioCompletion(cmd.segmentId, 100, now);
            break;
          }
          const text = config.narrativeResolver(cmd.segmentId);
          if (text === null) {
            warnings.push(`No narrative text for segment ${cmd.segmentId}`);
            scheduleAudioCompletion(cmd.segmentId, 1000, now);
          } else {
            const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
            const poiId = cmd.segmentId.split(':')[0]!;
            const isMemorial = config.memorialPoiIds.includes(poiId);
            const rateMultiplier = isMemorial ? MEMORIAL_RATE_MULTIPLIER : 1;
            const duration = computeNarrationDurationMs(wordCount, wpm, rateMultiplier);
            scheduleAudioCompletion(cmd.segmentId, duration, now);
          }
          break;
        }
        case 'StopAudio':
          cancelAudio();
          break;
        case 'PauseAudio':
          pauseAudio(now);
          break;
        case 'ResumeAudio':
          resumeAudio(now);
          break;
        case 'ReleaseAll':
          // Mark all pending audio as cancelled
          cancelAudio();
          break;
        default:
          break;
      }
    }
  }

  function drainPendingBefore(beforeMs: number): void {
    // Process all pending actions that fire before the next trace event.
    // Order: by firesAtMs, then by insertionOrder.
    let nextAction = getNextPendingBefore(beforeMs);
    while (nextAction !== null) {
      removePendingAction(nextAction);

      if (nextAction.kind === 'timer') {
        const event: EngineEvent = {
          kind: 'Timer',
          id: nextAction.id,
          firedAt: nextAction.firesAtMs,
        };
        const prevPhase = engineState.phase;
        const result = reduce(engineState, event, nextAction.firesAtMs);
        engineState = result.state;
        timeline.push({
          atMs: nextAction.firesAtMs,
          kind: 'timer_fired',
          detail: `Timer(${nextAction.id})`,
        });

        if (result.state.phase !== prevPhase) {
          timeline.push({
            atMs: nextAction.firesAtMs,
            kind: 'state_change',
            detail: result.state.phase,
          });
        }
        processCommands(result.commands, nextAction.firesAtMs);
      } else {
        // Audio completion
        const event: EngineEvent = { kind: 'AudioFinished', segmentId: nextAction.segmentId };
        const result = reduce(engineState, event, nextAction.completesAtMs);

        const poiId = nextAction.segmentId.split(':')[0]!;
        consumedPois.push(poiId);
        timeline.push({
          atMs: nextAction.completesAtMs,
          kind: 'audio_finished',
          detail: nextAction.segmentId,
        });

        // Update trigger details
        const td = triggerDetails.find((t) => t.poiId === poiId && t.finishedAtMs === null);
        if (td) {
          // Mutate in place (we own the array)
          (td as { finishedAtMs: number | null }).finishedAtMs = nextAction.completesAtMs;
        }

        engineState = result.state;
        processCommands(result.commands, nextAction.completesAtMs);
      }

      nextAction = getNextPendingBefore(beforeMs);
    }
  }

  function getNextPendingBefore(beforeMs: number): PendingAction | null {
    let best: PendingAction | null = null;
    for (const action of pendingActions) {
      const actionTime = action.kind === 'timer' ? action.firesAtMs : action.completesAtMs;
      if (action.kind === 'audio' && action.pausedRemainingMs !== undefined) continue;
      if (actionTime >= beforeMs) continue;
      if (best === null) {
        best = action;
        continue;
      }
      const bestTime = best.kind === 'timer' ? best.firesAtMs : best.completesAtMs;
      if (
        actionTime < bestTime ||
        (actionTime === bestTime && action.insertionOrder < best.insertionOrder)
      ) {
        best = action;
      }
    }
    return best;
  }

  function removePendingAction(action: PendingAction): void {
    const idx = pendingActions.indexOf(action);
    if (idx >= 0) pendingActions.splice(idx, 1);
  }

  // ─── Main loop ──────────────────────────────────────────────────────────

  for (const traceEvent of trace) {
    lastMs = traceEvent.atMs;
    if (startMs === 0) startMs = traceEvent.atMs;

    // Drain any pending timers/audio that fire before this event
    drainPendingBefore(traceEvent.atMs);

    switch (traceEvent.kind) {
      case 'UserCommand': {
        if (traceEvent.cmd === 'start') {
          // Initialize pipeline and start tour
          pipelineState = initialPipelineState(
            config.tourConfig.route,
            config.tourConfig.geofences,
          );
          const event: EngineEvent = { kind: 'UserCommand', cmd: 'start' };
          const result = reduce(engineState, event, traceEvent.atMs, config.tourConfig);
          engineState = result.state;
          tourStarted = true;
          timeline.push({ atMs: traceEvent.atMs, kind: 'tour_start', detail: 'Tour started' });
          processCommands(result.commands, traceEvent.atMs);
        } else if (traceEvent.cmd === 'end') {
          const event: EngineEvent = { kind: 'UserCommand', cmd: 'end' };
          const result = reduce(engineState, event, traceEvent.atMs);
          engineState = result.state;
          timeline.push({ atMs: traceEvent.atMs, kind: 'tour_end', detail: 'Tour ended' });
          processCommands(result.commands, traceEvent.atMs);
        } else {
          const event: EngineEvent = { kind: 'UserCommand', cmd: traceEvent.cmd };
          const result = reduce(engineState, event, traceEvent.atMs);
          engineState = result.state;
          processCommands(result.commands, traceEvent.atMs);
        }
        break;
      }

      case 'GpsFix': {
        if (!tourStarted || pipelineState === null) {
          // GPS fixes before tour start are ignored
          break;
        }

        // Feed through the REAL production pipeline
        const pipelineOutput: PipelineOutput = step(pipelineState, traceEvent.fix, traceEvent.atMs);

        if (isRejected(pipelineOutput)) {
          rejectedFixes++;
          const reason = pipelineOutput.reject;
          rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
          timeline.push({
            atMs: traceEvent.atMs,
            kind: 'fix_rejected',
            detail: `Rejected: ${reason}`,
          });
          pipelineState = pipelineOutput.nextState;

          // Feed rejection event to reducer
          const event: EngineEvent = {
            kind: 'LocationRejected',
            reason,
            update: traceEvent.fix,
          };
          const result = reduce(engineState, event, traceEvent.atMs);
          engineState = result.state;
          processCommands(result.commands, traceEvent.atMs);
        } else {
          acceptedFixes++;

          // BUG 5 FIX (mirrors production locationAdapter): after a fire,
          // advance the pipeline state's consumed set so subsequent fixes
          // short-circuit for that POI. Without this, the pipeline fires
          // the same POI on every dwell-meeting fix.
          let nextPipeline = pipelineOutput.nextState;
          if (pipelineOutput.fire !== undefined) {
            const newConsumed = new Set(nextPipeline.consumed);
            newConsumed.add(pipelineOutput.fire);
            // Drop the fired POI's dwell entry
            const { [pipelineOutput.fire]: _dropped, ...remainingDwell } = nextPipeline.dwell;
            nextPipeline = {
              ...nextPipeline,
              consumed: newConsumed,
              dwell: remainingDwell,
            };
          }
          pipelineState = nextPipeline;

          timeline.push({
            atMs: traceEvent.atMs,
            kind: 'fix_accepted',
            detail: `accepted (along=${pipelineOutput.accepted.alongRouteM.toFixed(0)}m)`,
          });

          // Feed accepted event to reducer
          const acceptedEvent: EngineEvent = {
            kind: 'LocationAccepted',
            update: pipelineOutput.accepted,
          };
          const result = reduce(engineState, acceptedEvent, traceEvent.atMs);
          engineState = result.state;
          processCommands(result.commands, traceEvent.atMs);

          // If pipeline fired a POI, emit GeofenceDwell
          if (pipelineOutput.fire !== undefined) {
            const poiId = pipelineOutput.fire;
            firedPois.push(poiId);

            const entryTime = geofenceEntryTimes.get(poiId);
            const triggerLatencyMs = entryTime !== undefined ? traceEvent.atMs - entryTime : null;

            timeline.push({ atMs: traceEvent.atMs, kind: 'poi_fired', detail: `POI: ${poiId}` });

            const dwellEvent: EngineEvent = { kind: 'GeofenceDwell', poiId };
            const dwellResult = reduce(engineState, dwellEvent, traceEvent.atMs);
            engineState = dwellResult.state;
            processCommands(dwellResult.commands, traceEvent.atMs);

            // Compute narration duration for trigger detail
            const segId = `${poiId}:${config.tourConfig.language}`;
            const text = config.narrativeResolver(segId);
            const wordCount = text ? text.split(/\s+/).filter((w) => w.length > 0).length : 0;
            const isMemorial = config.memorialPoiIds.includes(poiId);
            const rateMultiplier = isMemorial ? MEMORIAL_RATE_MULTIPLIER : 1;
            const narrationDuration = computeNarrationDurationMs(wordCount, wpm, rateMultiplier);

            triggerDetails.push({
              poiId,
              firedAtMs: traceEvent.atMs,
              finishedAtMs: null,
              narrationDurationMs: narrationDuration,
              triggerLatencyMs,
            });
          }

          // Track geofence entry times for POIs we're inside
          // (Using pipeline's dwell state to track entries)
          if (nextPipeline.dwell) {
            for (const poiId of Object.keys(nextPipeline.dwell)) {
              if (!geofenceEntryTimes.has(poiId)) {
                geofenceEntryTimes.set(poiId, traceEvent.atMs);
              }
            }
          }
          // Clear entries for POIs no longer in dwell
          for (const [poiId] of geofenceEntryTimes) {
            if (!nextPipeline.dwell[poiId]) {
              geofenceEntryTimes.delete(poiId);
            }
          }
        }
        break;
      }

      case 'AppBackground': {
        const event: EngineEvent = { kind: 'FocusLoss' };
        const result = reduce(engineState, event, traceEvent.atMs);
        engineState = result.state;
        timeline.push({ atMs: traceEvent.atMs, kind: 'focus_loss', detail: 'App backgrounded' });
        processCommands(result.commands, traceEvent.atMs);
        break;
      }

      case 'AppForeground': {
        const event: EngineEvent = { kind: 'FocusRegain' };
        const result = reduce(engineState, event, traceEvent.atMs);
        engineState = result.state;
        timeline.push({ atMs: traceEvent.atMs, kind: 'focus_regain', detail: 'App foregrounded' });
        processCommands(result.commands, traceEvent.atMs);
        break;
      }

      case 'TtsUnavailable': {
        ttsAvailable = false;
        timeline.push({ atMs: traceEvent.atMs, kind: 'fault', detail: 'TTS unavailable' });
        break;
      }

      case 'TtsAvailable': {
        ttsAvailable = true;
        timeline.push({ atMs: traceEvent.atMs, kind: 'fault', detail: 'TTS available' });
        break;
      }

      case 'AudioInterrupted': {
        // Match production TourRuntime: an OS-level stop dispatches FocusLoss,
        // which pauses playback while leaving the POI unconsumed. It must not
        // masquerade as AudioFinished — doing so would permanently discard a
        // segment the rider did not hear.
        timeline.push({ atMs: traceEvent.atMs, kind: 'fault', detail: 'Audio interrupted' });
        const result = reduce(engineState, { kind: 'FocusLoss' }, traceEvent.atMs);
        engineState = result.state;
        timeline.push({
          atMs: traceEvent.atMs,
          kind: 'focus_loss',
          detail: 'Audio focus interrupted',
        });
        processCommands(result.commands, traceEvent.atMs);
        break;
      }
    }
  }

  // Drain remaining pending actions
  drainPendingBefore(lastMs + 60_000);

  // Check for stuck playing using the public TourState discriminant.
  const stuckPlaying = getPlayingSegmentId(engineState) !== null;
  if (stuckPlaying) {
    errors.push('Segment still playing at simulation end');
  }

  // Pending timers that never fired
  const pendingTimersAtEnd = pendingActions
    .filter((a): a is PendingTimer => a.kind === 'timer')
    .map((t) => t.id);

  return {
    durationMs: lastMs - startMs,
    acceptedFixes,
    rejectedFixes,
    rejectionReasons,
    firedPois,
    consumedPois,
    commandsEmitted,
    stuckPlaying,
    pendingTimersAtEnd,
    warnings,
    errors,
    timeline,
    finalPhase: engineState.phase,
    triggerDetails,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPlayingSegmentId(state: TourState): string | null {
  switch (state.phase) {
    case 'Active':
    case 'Standby':
    case 'DeadReckoning':
    case 'Deviation':
      return state.session.playing?.segmentId ?? null;
    case 'Idle':
    case 'Ended':
      return null;
  }
}

function formatCommand(cmd: EngineCommand): string {
  switch (cmd.kind) {
    case 'PlaySegment':
      return `PlaySegment(${cmd.segmentId}, ${cmd.source})`;
    case 'StopAudio':
      return 'StopAudio';
    case 'PauseAudio':
      return 'PauseAudio';
    case 'ResumeAudio':
      return `ResumeAudio(offset=${cmd.offsetMs})`;
    case 'RequestLocationMode':
      return `RequestLocationMode(${cmd.mode})`;
    case 'ScheduleTimer':
      return `ScheduleTimer(${cmd.id}, ${cmd.afterMs}ms)`;
    case 'CancelTimer':
      return `CancelTimer(${cmd.id})`;
    case 'ShowDeviationPrompt':
      return 'ShowDeviationPrompt';
    case 'HideDeviationPrompt':
      return 'HideDeviationPrompt';
    case 'ReleaseAll':
      return 'ReleaseAll';
    case 'RequestDecryptedSegment':
      return `RequestDecryptedSegment(${cmd.segmentId})`;
  }
}
