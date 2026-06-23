/**
 * Tramio property-based testing helper.
 *
 * All fast-check property tests in this workspace go through `property(...)`
 * so we get three guarantees at every call site:
 *
 *   1. `numRuns >= 100`. Caller may bump it higher; lower values are clamped.
 *   2. A deterministic seed under CI (env `CI=true`) so a failure on the
 *      build server reproduces locally with the same counterexample.
 *      `TRAMIO_FC_SEED` overrides the default for ad-hoc bisection.
 *   3. A standardized Jest test name following the design.md tag template:
 *
 *          "Feature: urban-narrative-mvp, Property {n}: {short title}"
 *
 *      This is what links a failing test back to a numbered correctness
 *      property in design.md (Property 1..20). Calling the helper without
 *      a property number is a hard error - we never want untagged property
 *      tests slipping in.
 *
 * Usage:
 *
 *   import fc from 'fast-check';
 *   import { property } from '../../tooling/property';
 *
 *   describe('geofence pipeline', () => {
 *     property(
 *       { n: 1, title: 'rejects low-accuracy and spike updates' },
 *       fc.integer(),
 *       (x) => {
 *         expect(typeof x).toBe('number');
 *       },
 *     );
 *   });
 */
import * as fc from 'fast-check';

/** The feature slug the test name template binds to. */
export const FEATURE_SLUG = 'urban-narrative-mvp';

/** Hard floor for `numRuns`. Set by spec convention; do not lower. */
export const MIN_NUM_RUNS = 100;

/** Deterministic seed used whenever `CI=true` and no override is set. */
export const DEFAULT_CI_SEED = 0xc0ffee;

/**
 * Resolve the fast-check seed for the current run.
 *
 * Precedence:
 *   1. Numeric `TRAMIO_FC_SEED` env var (always wins; useful for bisection).
 *   2. `DEFAULT_CI_SEED` when `process.env.CI` is truthy.
 *   3. `undefined` locally, which lets fast-check pick a random seed.
 */
export function resolveSeed(): number | undefined {
  const override = process.env.TRAMIO_FC_SEED;
  if (override !== undefined && override !== '') {
    const parsed = Number(override);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0') {
    return DEFAULT_CI_SEED;
  }
  return undefined;
}

/** Identifies a numbered property from design.md. */
export interface PropertyTag {
  /** Property number from design.md, e.g. 1..20. Must be a positive integer. */
  readonly n: number;
  /** Short human-readable title; appears verbatim in the Jest test name. */
  readonly title: string;
}

/** Per-test overrides on top of the shared defaults. */
export interface PropertyOptions {
  /**
   * Bump the number of runs above the floor. Values below `MIN_NUM_RUNS`
   * are clamped up rather than rejected.
   */
  readonly numRuns?: number;
  /** Override the seed for one specific test. */
  readonly seed?: number;
  /** Override the per-test timeout (ms). Defaults to fast-check's own. */
  readonly timeoutMs?: number;
  /** When true, registers the test with `it.only`. */
  readonly only?: boolean;
  /** When true, registers the test with `it.skip`. */
  readonly skip?: boolean;
}

/** Format a property tag into the standardized Jest test name. */
export function formatPropertyName(tag: PropertyTag): string {
  if (!Number.isInteger(tag.n) || tag.n <= 0) {
    throw new Error(`property(): tag.n must be a positive integer, got ${String(tag.n)}`);
  }
  const title = tag.title.trim();
  if (title.length === 0) {
    throw new Error('property(): tag.title must be a non-empty string');
  }
  return `Feature: ${FEATURE_SLUG}, Property ${tag.n}: ${title}`;
}

/**
 * Build the `fc.Parameters` object the helper hands to fast-check, with
 * `numRuns` and `seed` resolved against the spec defaults.
 *
 * Exported so individual tests can pass these same parameters to
 * `fc.assert` directly when they need a non-standard call shape (e.g.
 * `fc.asyncProperty`).
 */
export function resolveParameters(opts: PropertyOptions = {}): fc.Parameters<unknown> {
  const numRuns = Math.max(MIN_NUM_RUNS, opts.numRuns ?? MIN_NUM_RUNS);
  const seed = opts.seed ?? resolveSeed();
  const params: fc.Parameters<unknown> = { numRuns };
  if (seed !== undefined) {
    params.seed = seed;
  }
  if (opts.timeoutMs !== undefined) {
    params.timeout = opts.timeoutMs;
  }
  return params;
}

// Overload so callers can pass arbitrary tuples of arbitraries with strong
// typing on the predicate, mirroring `fc.property`'s own variadic shape.
export function property<Ts extends [unknown, ...unknown[]]>(
  tag: PropertyTag,
  ...rest: [
    ...{ [K in keyof Ts]: fc.Arbitrary<Ts[K]> },
    (...args: Ts) => boolean | void | Promise<boolean | void>,
    PropertyOptions?,
  ]
): void;
export function property(tag: PropertyTag, ...rest: ReadonlyArray<unknown>): void {
  // Split off the optional trailing PropertyOptions and the predicate.
  let opts: PropertyOptions = {};
  const last = rest[rest.length - 1];
  const isOptions =
    typeof last === 'object' &&
    last !== null &&
    !Array.isArray(last) &&
    typeof (last as { generate?: unknown }).generate !== 'function';
  let predicateAndArbs: ReadonlyArray<unknown>;
  if (isOptions) {
    opts = last as PropertyOptions;
    predicateAndArbs = rest.slice(0, -1);
  } else {
    predicateAndArbs = rest;
  }
  const predicate = predicateAndArbs[predicateAndArbs.length - 1];
  if (typeof predicate !== 'function') {
    throw new Error('property(): predicate function is required as last arg');
  }
  const arbitraries = predicateAndArbs.slice(0, -1) as ReadonlyArray<fc.Arbitrary<unknown>>;

  const name = formatPropertyName(tag);
  const params = resolveParameters(opts);

  // Use `it` from Jest's globals; we accept that this helper is only
  // imported from inside `describe` blocks.
  const runner: jest.It = opts.only ? it.only : opts.skip ? it.skip : it;

  runner(name, async () => {
    // We construct the property at run time rather than at register time so
    // the test name in Jest's output is always exactly the formatted tag.
    // fast-check exposes `property` and `asyncProperty` as separate factories;
    // we always go through `asyncProperty` so the same call site works for
    // sync and async predicates (Jest awaits the returned promise either way).
    const built = (
      fc.asyncProperty as unknown as (
        ...args: ReadonlyArray<unknown>
      ) => fc.IAsyncPropertyWithHooks<unknown>
    )(...arbitraries, predicate);
    await fc.assert(built, params);
  });
}
