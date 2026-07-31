/**
 * Dependency-free in-memory fixed-window rate limiter.
 *
 * Keyed by an opaque string (typically `deviceId` or client IP). Each key
 * gets an independent counter that resets every `windowMs`. When the counter
 * exceeds `maxRequests` within the window the call returns `{ allowed: false }`.
 *
 * Memory is bounded: stale windows are lazily evicted on access and a
 * periodic sweep (every `sweepIntervalMs`) removes expired entries so memory
 * does not grow unbounded if many distinct keys appear and then disappear.
 *
 * NOT suitable for multi-process deployments — this is a single-process,
 * self-hosted backend.
 */

export interface RateLimiterOptions {
  /** Maximum requests allowed per window. */
  readonly maxRequests: number;
  /** Window duration in milliseconds. */
  readonly windowMs: number;
  /**
   * Interval (ms) between background sweeps of expired entries.
   * Defaults to `windowMs * 2`. Pass 0 to disable background sweeps
   * (entries will still be lazily evicted on access).
   */
  readonly sweepIntervalMs?: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Remaining requests in the current window (0 if blocked). */
  readonly remaining: number;
  /** Unix ms when the current window resets. */
  readonly resetsAt: number;
}

interface WindowEntry {
  count: number;
  /** Start of the current window (Unix ms). */
  windowStart: number;
}

export interface RateLimiter {
  /** Check + consume one token for `key`. */
  consume(key: string): RateLimitResult;
  /** Dispose the background sweep timer (for tests / graceful shutdown). */
  dispose(): void;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { maxRequests, windowMs } = opts;
  const sweepInterval = opts.sweepIntervalMs ?? windowMs * 2;
  const entries = new Map<string, WindowEntry>();

  // Background sweep (unref'd so it doesn't keep the process alive).
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (sweepInterval > 0) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (now - entry.windowStart >= windowMs) {
          entries.delete(key);
        }
      }
    }, sweepInterval);
    // Prevent timer from keeping Node alive during tests.
    if (typeof sweepTimer === 'object' && 'unref' in sweepTimer) {
      sweepTimer.unref();
    }
  }

  return {
    consume(key: string): RateLimitResult {
      const now = Date.now();
      let entry = entries.get(key);

      // Reset if window expired or first request.
      if (!entry || now - entry.windowStart >= windowMs) {
        entry = { count: 0, windowStart: now };
        entries.set(key, entry);
      }

      const resetsAt = entry.windowStart + windowMs;

      if (entry.count >= maxRequests) {
        return { allowed: false, remaining: 0, resetsAt };
      }

      entry.count += 1;
      const remaining = maxRequests - entry.count;
      return { allowed: true, remaining, resetsAt };
    },

    dispose() {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      entries.clear();
    },
  };
}
