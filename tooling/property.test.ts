/**
 * Tests for the shared property-test helper.
 *
 * These are deliberately Jest unit tests (not property tests) because they
 * verify the contract of the helper itself - tag template, numRuns floor,
 * seed resolution. Tests that USE the helper live next to their package
 * code under `packages/*`.
 */
import * as fc from 'fast-check';
import {
  DEFAULT_CI_SEED,
  FEATURE_SLUG,
  MIN_NUM_RUNS,
  formatPropertyName,
  property,
  resolveParameters,
  resolveSeed,
} from './property';

describe('formatPropertyName', () => {
  it('builds the standardized test name template', () => {
    expect(formatPropertyName({ n: 1, title: 'rejects spike updates' })).toBe(
      `Feature: ${FEATURE_SLUG}, Property 1: rejects spike updates`,
    );
  });

  it('rejects non-positive property numbers', () => {
    expect(() => formatPropertyName({ n: 0, title: 'x' })).toThrow();
    expect(() => formatPropertyName({ n: -1, title: 'x' })).toThrow();
    expect(() => formatPropertyName({ n: 1.5, title: 'x' })).toThrow();
  });

  it('rejects empty titles', () => {
    expect(() => formatPropertyName({ n: 1, title: '' })).toThrow();
    expect(() => formatPropertyName({ n: 1, title: '   ' })).toThrow();
  });
});

describe('resolveSeed', () => {
  const originalCi = process.env.CI;
  const originalSeed = process.env.TRAMIO_FC_SEED;

  afterEach(() => {
    process.env.CI = originalCi;
    process.env.TRAMIO_FC_SEED = originalSeed;
  });

  it('returns DEFAULT_CI_SEED when CI is set', () => {
    process.env.CI = 'true';
    delete process.env.TRAMIO_FC_SEED;
    expect(resolveSeed()).toBe(DEFAULT_CI_SEED);
  });

  it('returns undefined when CI is unset and no override', () => {
    delete process.env.CI;
    delete process.env.TRAMIO_FC_SEED;
    expect(resolveSeed()).toBeUndefined();
  });

  it('honors TRAMIO_FC_SEED override even outside CI', () => {
    delete process.env.CI;
    process.env.TRAMIO_FC_SEED = '42';
    expect(resolveSeed()).toBe(42);
  });

  it('honors TRAMIO_FC_SEED override under CI', () => {
    process.env.CI = 'true';
    process.env.TRAMIO_FC_SEED = '7';
    expect(resolveSeed()).toBe(7);
  });

  it('treats CI=false / CI=0 as "not in CI"', () => {
    delete process.env.TRAMIO_FC_SEED;
    process.env.CI = 'false';
    expect(resolveSeed()).toBeUndefined();
    process.env.CI = '0';
    expect(resolveSeed()).toBeUndefined();
  });
});

describe('resolveParameters', () => {
  it('clamps numRuns up to the spec floor', () => {
    const params = resolveParameters({ numRuns: 5 });
    expect(params.numRuns).toBe(MIN_NUM_RUNS);
  });

  it('preserves higher numRuns values', () => {
    const params = resolveParameters({ numRuns: 500 });
    expect(params.numRuns).toBe(500);
  });

  it('defaults to the floor when no override is supplied', () => {
    const params = resolveParameters();
    expect(params.numRuns).toBe(MIN_NUM_RUNS);
  });

  it('uses the resolved seed by default', () => {
    const previousCi = process.env.CI;
    process.env.CI = 'true';
    try {
      const params = resolveParameters();
      expect(params.seed).toBe(DEFAULT_CI_SEED);
    } finally {
      process.env.CI = previousCi;
    }
  });

  it('lets a per-test seed override the default', () => {
    const params = resolveParameters({ seed: 1234 });
    expect(params.seed).toBe(1234);
  });
});

describe('property', () => {
  // Smoke-test the helper end-to-end against a tiny invariant. If this
  // passes, the wiring (test name, numRuns floor, fast-check.assert call
  // shape) is healthy.
  property(
    { n: 0xfff, title: 'helper smoke test - addition is commutative' },
    fc.integer(),
    fc.integer(),
    (a, b) => a + b === b + a,
    { numRuns: 100, seed: 1 },
  );
});
