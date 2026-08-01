/**
 * Trace event types for the deterministic ride simulator.
 *
 * A trace is a chronologically-ordered sequence of events that drive a
 * simulation. Events include raw GPS fixes, lifecycle transitions, user
 * commands, and simulated faults. All data is serializable plain JSON.
 *
 * @module
 */

import type { PositionUpdate } from '../../engine/src';

// ─── GPS Fix Events ─────────────────────────────────────────────────────────

/** A raw GPS fix delivered to the pipeline at a specific wall-clock time. */
export interface GpsFixEvent {
  readonly kind: 'GpsFix';
  /** Wall-clock ms since epoch when this fix is delivered to the pipeline. */
  readonly atMs: number;
  readonly fix: PositionUpdate;
}

// ─── Lifecycle / Focus Events ───────────────────────────────────────────────

/** App goes to background (audio focus lost). */
export interface AppBackgroundEvent {
  readonly kind: 'AppBackground';
  readonly atMs: number;
}

/** App returns to foreground (audio focus regained). */
export interface AppForegroundEvent {
  readonly kind: 'AppForeground';
  readonly atMs: number;
}

// ─── User Command Events ────────────────────────────────────────────────────

/** User issues a tour command. */
export interface UserCommandEvent {
  readonly kind: 'UserCommand';
  readonly atMs: number;
  readonly cmd: 'start' | 'end' | 'resume-route' | 'switch-route' | 'dismiss';
}

// ─── Fault Injection Events ─────────────────────────────────────────────────

/** TTS/audio system becomes unavailable. */
export interface TtsUnavailableEvent {
  readonly kind: 'TtsUnavailable';
  readonly atMs: number;
}

/** TTS/audio system becomes available again. */
export interface TtsAvailableEvent {
  readonly kind: 'TtsAvailable';
  readonly atMs: number;
}

/** Currently-playing audio is interrupted externally (e.g. phone call). */
export interface AudioInterruptedEvent {
  readonly kind: 'AudioInterrupted';
  readonly atMs: number;
}

// ─── Union ──────────────────────────────────────────────────────────────────

/** All possible trace events. */
export type TraceEvent =
  | GpsFixEvent
  | AppBackgroundEvent
  | AppForegroundEvent
  | UserCommandEvent
  | TtsUnavailableEvent
  | TtsAvailableEvent
  | AudioInterruptedEvent;
