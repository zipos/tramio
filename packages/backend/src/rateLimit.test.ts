/**
 * Unit tests for the in-memory rate limiter.
 */
import { createRateLimiter } from './rateLimit';

describe('createRateLimiter', () => {
  it('allows requests within the limit', () => {
    const limiter = createRateLimiter({ maxRequests: 3, windowMs: 60_000, sweepIntervalMs: 0 });
    try {
      expect(limiter.consume('key-a').allowed).toBe(true);
      expect(limiter.consume('key-a').allowed).toBe(true);
      expect(limiter.consume('key-a').allowed).toBe(true);
    } finally {
      limiter.dispose();
    }
  });

  it('blocks requests over the limit', () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000, sweepIntervalMs: 0 });
    try {
      limiter.consume('key-b');
      limiter.consume('key-b');
      const result = limiter.consume('key-b');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    } finally {
      limiter.dispose();
    }
  });

  it('tracks remaining count correctly', () => {
    const limiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000, sweepIntervalMs: 0 });
    try {
      expect(limiter.consume('key-c').remaining).toBe(4);
      expect(limiter.consume('key-c').remaining).toBe(3);
      expect(limiter.consume('key-c').remaining).toBe(2);
      expect(limiter.consume('key-c').remaining).toBe(1);
      expect(limiter.consume('key-c').remaining).toBe(0);
      expect(limiter.consume('key-c').remaining).toBe(0); // blocked
    } finally {
      limiter.dispose();
    }
  });

  it('isolates keys independently', () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000, sweepIntervalMs: 0 });
    try {
      expect(limiter.consume('key-x').allowed).toBe(true);
      expect(limiter.consume('key-x').allowed).toBe(false);
      // Different key still has quota
      expect(limiter.consume('key-y').allowed).toBe(true);
      expect(limiter.consume('key-y').allowed).toBe(false);
    } finally {
      limiter.dispose();
    }
  });

  it('resets after window expires', () => {
    const realNow = Date.now;
    let fakeTime = 1000;
    Date.now = () => fakeTime;

    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 100, sweepIntervalMs: 0 });
    try {
      expect(limiter.consume('key-d').allowed).toBe(true);
      expect(limiter.consume('key-d').allowed).toBe(false);

      // Advance time past window
      fakeTime += 101;
      expect(limiter.consume('key-d').allowed).toBe(true);
    } finally {
      limiter.dispose();
      Date.now = realNow;
    }
  });

  it('provides correct resetsAt', () => {
    const realNow = Date.now;
    const fakeTime = 5000;
    Date.now = () => fakeTime;

    const limiter = createRateLimiter({ maxRequests: 5, windowMs: 200, sweepIntervalMs: 0 });
    try {
      const result = limiter.consume('key-e');
      expect(result.resetsAt).toBe(5200);
    } finally {
      limiter.dispose();
      Date.now = realNow;
    }
  });

  it('dispose clears state', () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000, sweepIntervalMs: 0 });
    limiter.consume('key-f');
    expect(limiter.consume('key-f').allowed).toBe(false);
    limiter.dispose();
    // After dispose, internal map is cleared — new calls start fresh
    expect(limiter.consume('key-f').allowed).toBe(true);
  });
});
