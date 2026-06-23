// In-memory fake of the Audio_Service native bridge.
//
// Lets us test the TS wrapper and (eventually) the engine command
// translator without standing up a JSI / RN host. The fake mirrors the
// observable behavior the iOS / Android implementations are required to
// honor: single-segment invariant, captured-offset on pause, duck
// percentage clamping, listener token round-trip.
//
// Used by:
//   - unit tests for `AudioService` (this package)
//   - the engine wiring tests (task 13.1, future)
//
// Not exported from the package barrel; tests import directly.

import type { Spec } from './NativeAudioService';
import type {
  AudioServiceEvent,
  AudioSource,
  DuckingChangeEvent,
  FocusLossEvent,
  FocusRegainEvent,
  PlaybackFinishedEvent,
} from './types';

interface ParsedPlay {
  readonly segmentId: string;
  readonly source: AudioSource;
  readonly opts: {
    readonly startOffsetMs: number;
    readonly gainOffsetDb: number;
    readonly initialDuckPercent: number;
  };
}

type ListenerKind = AudioServiceEvent['kind'];
type AnyListener = (ev: unknown) => void;

interface ListenerEntry {
  readonly kind: ListenerKind;
  readonly cb: AnyListener;
}

export interface FakeBridgeCall {
  readonly method: keyof Spec;
  readonly args: ReadonlyArray<unknown>;
}

/**
 * Test double for the Audio_Service spec. Records every call so
 * assertions can be made on order + arguments, and exposes `emit*`
 * helpers so tests can drive native-event paths deterministically.
 */
export class FakeAudioBridge implements Spec {
  readonly calls: FakeBridgeCall[] = [];

  private nextToken = 1;
  private readonly listeners = new Map<string, ListenerEntry>();

  private currentSegmentId: string | null = null;
  private currentOffsetMs = 0;
  private currentGainOffsetDb = 0;
  private currentDuckPercent = 0;

  /** Most recent successful play, for tests that want to introspect. */
  lastPlay: ParsedPlay | null = null;

  // -- Spec methods --------------------------------------------------

  async play(segmentId: string, sourceJson: string, optsJson: string): Promise<void> {
    this.calls.push({ method: 'play', args: [segmentId, sourceJson, optsJson] });
    const source = JSON.parse(sourceJson) as AudioSource;
    const opts = JSON.parse(optsJson) as ParsedPlay['opts'];

    // Single-segment invariant: any in-flight segment is implicitly
    // stopped (Req 1.3). We don't emit `PlaybackFinished` for the
    // displaced segment because the wrapper's `playStream/playUrl` is
    // shaped as a fire-and-forget command.
    this.currentSegmentId = segmentId;
    this.currentOffsetMs = Math.max(0, Math.floor(opts.startOffsetMs));
    this.currentGainOffsetDb = opts.gainOffsetDb;
    this.currentDuckPercent = opts.initialDuckPercent;
    this.lastPlay = { segmentId, source, opts };
  }

  async pause(): Promise<number> {
    this.calls.push({ method: 'pause', args: [] });
    return this.currentOffsetMs;
  }

  async resume(offsetMs: number): Promise<void> {
    this.calls.push({ method: 'resume', args: [offsetMs] });
    this.currentOffsetMs = Math.max(0, Math.floor(offsetMs));
  }

  async stop(): Promise<void> {
    this.calls.push({ method: 'stop', args: [] });
    this.currentSegmentId = null;
    this.currentOffsetMs = 0;
  }

  async duck(percent: number): Promise<void> {
    this.calls.push({ method: 'duck', args: [percent] });
    const clean = Math.max(0, Math.min(100, percent));
    this.currentDuckPercent = clean;
    this.dispatch({ kind: 'DuckingChange', percent: clean });
  }

  addPlaybackFinishedListener(cb: (ev: PlaybackFinishedEvent) => void): string {
    return this.addListener('PlaybackFinished', cb as AnyListener);
  }
  addFocusLossListener(cb: (ev: FocusLossEvent) => void): string {
    return this.addListener('FocusLoss', cb as AnyListener);
  }
  addFocusRegainListener(cb: (ev: FocusRegainEvent) => void): string {
    return this.addListener('FocusRegain', cb as AnyListener);
  }
  addDuckingChangeListener(cb: (ev: DuckingChangeEvent) => void): string {
    return this.addListener('DuckingChange', cb as AnyListener);
  }

  removeListener(token: string): void {
    this.calls.push({ method: 'removeListener', args: [token] });
    this.listeners.delete(token);
  }

  // -- Test helpers --------------------------------------------------

  /**
   * Simulate the native side reaching end-of-stream for the active
   * segment. Tests use this to exercise `onPlaybackFinished` flow.
   */
  emitPlaybackFinished(reason: PlaybackFinishedEvent['reason'] = 'completed'): void {
    if (this.currentSegmentId === null) {
      throw new Error('FakeAudioBridge.emitPlaybackFinished: no active segment');
    }
    const segmentId = this.currentSegmentId;
    this.currentSegmentId = null;
    this.dispatch({ kind: 'PlaybackFinished', segmentId, reason });
  }

  emitFocusLoss(): void {
    const offset = this.currentOffsetMs;
    const segmentId = this.currentSegmentId ?? undefined;
    this.dispatch({
      kind: 'FocusLoss',
      capturedOffsetMs: offset,
      ...(segmentId !== undefined ? { segmentId } : {}),
    });
  }

  emitFocusRegain(): void {
    const segmentId = this.currentSegmentId ?? undefined;
    this.dispatch({
      kind: 'FocusRegain',
      ...(segmentId !== undefined ? { segmentId } : {}),
    });
  }

  /** Snapshot helpers for assertions. */
  getCurrentSegmentId(): string | null {
    return this.currentSegmentId;
  }
  getCurrentOffsetMs(): number {
    return this.currentOffsetMs;
  }
  getCurrentGainOffsetDb(): number {
    return this.currentGainOffsetDb;
  }
  getCurrentDuckPercent(): number {
    return this.currentDuckPercent;
  }
  /** Number of currently-attached listeners across every kind. */
  listenerCount(): number {
    return this.listeners.size;
  }

  // -- Internals -----------------------------------------------------

  private addListener(kind: ListenerKind, cb: AnyListener): string {
    const token = `fake-${kind}-${this.nextToken++}`;
    this.listeners.set(token, { kind, cb });
    return token;
  }

  private dispatch(ev: AudioServiceEvent): void {
    // Snapshot listeners so a callback that detaches itself doesn't
    // mutate the iteration target.
    const snapshot = Array.from(this.listeners.values());
    for (const entry of snapshot) {
      if (entry.kind !== ev.kind) continue;
      // Native side hands each listener the event payload WITHOUT the
      // `kind` discriminator; the wrapper re-adds it. Strip it here so
      // the fake matches the production contract.
      const { kind: _kind, ...payload } = ev;
      entry.cb(payload);
    }
  }
}
