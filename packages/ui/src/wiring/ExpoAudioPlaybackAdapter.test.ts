// ExpoAudioPlaybackAdapter — unit tests with injected factory.
//
// Tests cover:
//   - Stale async race: play(A), play(B) before A resolves
//   - Stale callback after B started: old A callback suppressed
//   - onStart deduplication (exactly once)
//   - onComplete/onError deduplication (exactly once per terminal)
//   - stop() suppresses pending callbacks
//   - release() suppresses all future callbacks
//   - Natural complete releases player and listeners

import type { AudioPlaybackCallbacks } from './AudioPlaybackPort';
import { ExpoAudioPlaybackAdapter, type CreateAudioPlayerFn } from './ExpoAudioPlaybackAdapter';

// ─── Fake player ──────────────────────────────────────────────────────────

interface FakePlayer {
  readonly uri: string;
  playing: boolean;
  currentTime: number;
  duration: number;
  removed: boolean;
  statusHandler: ((status: FakeStatus) => void) | null;
  subscriptionRemoved: boolean;
  play(): void;
  pause(): void;
  remove(): void;
  addListener(event: string, handler: (status: FakeStatus) => void): { remove(): void };
  // Test helpers
  emitStatus(status: Partial<FakeStatus>): void;
}

interface FakeStatus {
  playing: boolean;
  isLoaded: boolean;
  didJustFinish: boolean;
  error: string | null;
  currentTime: number;
  duration: number;
}

function createFakePlayer(uri: string): FakePlayer {
  const player: FakePlayer = {
    uri,
    playing: false,
    currentTime: 0,
    duration: 30,
    removed: false,
    statusHandler: null,
    subscriptionRemoved: false,
    play() {
      this.playing = true;
    },
    pause() {
      this.playing = false;
    },
    remove() {
      this.removed = true;
    },
    addListener(_event: string, handler: (status: FakeStatus) => void) {
      this.statusHandler = handler;
      return {
        remove: () => {
          player.subscriptionRemoved = true;
          player.statusHandler = null;
        },
      };
    },
    emitStatus(partial: Partial<FakeStatus>) {
      const status: FakeStatus = {
        playing: false,
        isLoaded: true,
        didJustFinish: false,
        error: null,
        currentTime: 0,
        duration: 30,
        ...partial,
      };
      this.statusHandler?.(status);
    },
  };
  return player;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ExpoAudioPlaybackAdapter', () => {
  let players: FakePlayer[];
  let factory: CreateAudioPlayerFn;
  let adapter: ExpoAudioPlaybackAdapter;

  beforeEach(() => {
    players = [];
    factory = (source: { uri: string }) => {
      const p = createFakePlayer(source.uri);
      players.push(p);
      return p as unknown as ReturnType<CreateAudioPlayerFn>;
    };
    adapter = new ExpoAudioPlaybackAdapter(factory);
  });

  afterEach(() => {
    adapter.release();
  });

  it('creates player and fires onStart exactly once', () => {
    const log: string[] = [];
    const callbacks: AudioPlaybackCallbacks = {
      onStart: () => log.push('start'),
      onComplete: () => log.push('complete'),
    };

    adapter.play('/audio/a.m4a', callbacks);
    const player = players[0]!;

    // Emit loaded+playing twice.
    player.emitStatus({ isLoaded: true, playing: true });
    player.emitStatus({ isLoaded: true, playing: true });

    expect(log).toEqual(['start']);
  });

  it('fires onComplete exactly once on didJustFinish', () => {
    const log: string[] = [];
    adapter.play('/audio/a.m4a', {
      onStart: () => log.push('start'),
      onComplete: () => log.push('complete'),
    });
    const player = players[0]!;

    player.emitStatus({ isLoaded: true, playing: true });
    player.emitStatus({ didJustFinish: true });
    // Second didJustFinish should be ignored.
    player.emitStatus({ didJustFinish: true });

    expect(log).toEqual(['start', 'complete']);
    expect(player.removed).toBe(true);
    expect(player.subscriptionRemoved).toBe(true);
  });

  it('fires onError exactly once on status.error', () => {
    const log: string[] = [];
    adapter.play('/audio/a.m4a', {
      onError: (msg) => log.push(`error:${msg}`),
    });
    const player = players[0]!;

    player.emitStatus({ error: 'Decode failed' });
    player.emitStatus({ error: 'Decode failed again' });

    expect(log).toEqual(['error:Decode failed']);
    expect(player.removed).toBe(true);
  });

  it('stale race: play(A), play(B) — A callbacks suppressed', () => {
    const logA: string[] = [];
    const logB: string[] = [];

    adapter.play('/audio/a.m4a', {
      onStart: () => logA.push('start'),
      onComplete: () => logA.push('complete'),
    });
    const playerA = players[0]!;

    // Before A emits anything, play B.
    adapter.play('/audio/b.m4a', {
      onStart: () => logB.push('start'),
      onComplete: () => logB.push('complete'),
    });
    const playerB = players[1]!;

    // playerA was disposed by the second play().
    expect(playerA.removed).toBe(true);

    // If somehow A's handler fires (shouldn't happen since subscription removed),
    // it should still be safe due to generation check. Simulate if handler retained:
    // (In real impl the subscription is removed so this can't happen, but the
    // generation guard is the defense in depth.)

    // B starts normally.
    playerB.emitStatus({ isLoaded: true, playing: true });
    playerB.emitStatus({ didJustFinish: true });

    expect(logA).toEqual([]);
    expect(logB).toEqual(['start', 'complete']);
  });

  it('stale callback after B: old A callback does not fire on B', () => {
    const logA: string[] = [];
    const logB: string[] = [];

    adapter.play('/audio/a.m4a', {
      onComplete: () => logA.push('complete'),
      onError: () => logA.push('error'),
    });
    const playerA = players[0]!;

    // A starts playing.
    playerA.emitStatus({ isLoaded: true, playing: true });

    // Now play B (disposes A).
    adapter.play('/audio/b.m4a', {
      onStart: () => logB.push('start'),
      onComplete: () => logB.push('complete'),
    });
    const playerB = players[1]!;

    // Even if we somehow still have playerA reference, its handler was removed.
    // And A was removed.
    expect(playerA.removed).toBe(true);
    expect(playerA.subscriptionRemoved).toBe(true);

    // B completes.
    playerB.emitStatus({ isLoaded: true, playing: true });
    playerB.emitStatus({ didJustFinish: true });

    expect(logA).toEqual([]);
    expect(logB).toEqual(['start', 'complete']);
  });

  it('stop() suppresses all pending callbacks', () => {
    const log: string[] = [];
    adapter.play('/audio/a.m4a', {
      onStart: () => log.push('start'),
      onComplete: () => log.push('complete'),
      onError: () => log.push('error'),
    });
    const player = players[0]!;

    adapter.stop();

    // Player should be removed.
    expect(player.removed).toBe(true);
    expect(player.subscriptionRemoved).toBe(true);

    // No callbacks should have fired.
    expect(log).toEqual([]);
  });

  it('release() suppresses all future callbacks', () => {
    const log: string[] = [];
    adapter.play('/audio/a.m4a', {
      onStart: () => log.push('start'),
      onComplete: () => log.push('complete'),
    });
    const player = players[0]!;

    adapter.release();

    expect(player.removed).toBe(true);
    expect(log).toEqual([]);

    // Further play() calls are no-ops.
    adapter.play('/audio/b.m4a', {
      onStart: () => log.push('B-start'),
    });
    expect(players).toHaveLength(1); // No new player created.
  });

  it('pause() and resume() delegate to player', () => {
    adapter.play('/audio/a.m4a', {});
    const player = players[0]!;

    player.emitStatus({ isLoaded: true, playing: true });
    adapter.pause();
    expect(player.playing).toBe(false);

    adapter.resume();
    expect(player.playing).toBe(true);
  });

  it('getStatus() returns current player state', () => {
    adapter.play('/audio/a.m4a', {});
    const player = players[0]!;
    player.playing = true;
    player.currentTime = 5.5;
    player.duration = 30;

    const status = adapter.getStatus();
    expect(status.playing).toBe(true);
    expect(status.positionSec).toBe(5.5);
    expect(status.durationSec).toBe(30);
  });

  it('getStatus() returns zeros when no player', () => {
    const status = adapter.getStatus();
    expect(status).toEqual({ playing: false, positionSec: 0, durationSec: 0 });
  });

  it('natural complete releases player without invalidating callback', () => {
    const log: string[] = [];
    adapter.play('/audio/a.m4a', {
      onComplete: () => log.push('complete'),
    });
    const player = players[0]!;

    player.emitStatus({ isLoaded: true, playing: true });
    player.emitStatus({ didJustFinish: true });

    expect(log).toEqual(['complete']);
    expect(player.removed).toBe(true);

    // Adapter is still usable for a new play().
    adapter.play('/audio/b.m4a', {
      onStart: () => log.push('b-start'),
    });
    expect(players).toHaveLength(2);
    players[1]!.emitStatus({ isLoaded: true, playing: true });
    expect(log).toEqual(['complete', 'b-start']);
  });
});
