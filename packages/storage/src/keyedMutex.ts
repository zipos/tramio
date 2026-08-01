// KeyedMutex — keyed async serialization without permanent map leak.
//
// Same key serializes; different keys proceed concurrently.
// Idle keys are automatically removed from the internal map to prevent
// unbounded memory growth over time.

import { AsyncMutex } from './asyncMutex';

/**
 * A keyed mutual exclusion primitive. Operations on the same key serialize;
 * operations on different keys run concurrently.
 *
 * When a key becomes idle (no waiters and not held), its entry is removed
 * from the internal map to avoid permanent memory leaks.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, { mutex: AsyncMutex; refCount: number }>();

  /**
   * Execute `fn` while holding the lock for `key`.
   * Same-key calls serialize; different-key calls proceed concurrently.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const entry = this.acquire(key);
    const release = await entry.mutex.acquire();
    try {
      return await fn();
    } finally {
      release();
      this.release(key);
    }
  }

  /** Number of currently tracked keys (for testing). */
  get size(): number {
    return this.locks.size;
  }

  /** Whether a specific key currently has an active or queued lock. */
  has(key: string): boolean {
    return this.locks.has(key);
  }

  private acquire(key: string): { mutex: AsyncMutex; refCount: number } {
    let entry = this.locks.get(key);
    if (!entry) {
      entry = { mutex: new AsyncMutex(), refCount: 0 };
      this.locks.set(key, entry);
    }
    entry.refCount++;
    return entry;
  }

  private release(key: string): void {
    const entry = this.locks.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount === 0 && !entry.mutex.isLocked) {
      this.locks.delete(key);
    }
  }
}
