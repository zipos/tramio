// AsyncMutex — dependency-free async serialization primitive.
//
// Used by StorageBudget and the downloader's activation-critical section
// to prevent concurrent budget mutations and pack promotions from racing.
//
// Zero runtime dependencies; works in both Node and React Native.

/**
 * A simple async mutex (mutual exclusion lock) that serializes access to
 * a critical section. Awaiting `acquire()` returns a release function;
 * the caller MUST call release when done.
 *
 * Usage:
 * ```ts
 * const mutex = new AsyncMutex();
 * const release = await mutex.acquire();
 * try { ... } finally { release(); }
 * ```
 *
 * Or use the convenience `withLock`:
 * ```ts
 * await mutex.withLock(async () => { ... });
 * ```
 */
export class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  /**
   * Acquire the lock. Returns a release function. The caller MUST invoke
   * the release function exactly once when the critical section completes.
   */
  acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.buildRelease());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this.buildRelease()));
    });
  }

  /**
   * Execute `fn` while holding the lock. Guarantees release even if `fn` throws.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Whether the lock is currently held. Useful for assertions in tests. */
  get isLocked(): boolean {
    return this.locked;
  }

  /** Number of waiters queued behind the current holder. */
  get queueLength(): number {
    return this.queue.length;
  }

  private buildRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent
      released = true;
      const next = this.queue.shift();
      if (next) {
        // Hand lock to the next waiter without releasing.
        next();
      } else {
        this.locked = false;
      }
    };
  }
}
