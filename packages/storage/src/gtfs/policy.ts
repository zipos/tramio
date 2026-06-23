// GTFS feed age policy enforcement.
//
// Computes staleness flags from a `GtfsFeed` instance. The Tour_Engine
// consumes `drDisabled` to suppress entry into Dead_Reckoning mode when
// the feed is too old to trust for schedule-based position estimation.
// The UI layer surfaces non-blocking warnings when the feed is stale.
//
// Thresholds (from Requirements 18.3, 18.4):
//   - staleWarning: feed age > 30 days
//   - drDisabled:   feed age > 90 days
//
// @see Requirements 18.3, 18.4
// @see design.md "Tour_Engine > Dead_Reckoning entry, advance, reconcile"

import type { GtfsFeed, FeedAgeOptions } from './feed';

/** Days after which the feed is considered stale (Req 18.3). */
export const STALE_WARNING_DAYS = 30;

/** Days after which Dead_Reckoning is disabled (Req 18.4). */
export const DR_DISABLED_DAYS = 90;

/**
 * Result of evaluating the GTFS feed age policy. Both flags are
 * non-exclusive: when `drDisabled` is true, `staleWarning` is also true
 * (a 90-day-old feed is necessarily > 30 days old).
 */
export interface GtfsAgePolicy {
  /**
   * `true` when the feed is older than 30 days. The UI should display a
   * non-blocking warning that schedule-based features may be inaccurate.
   *
   * @see Requirement 18.3
   */
  readonly staleWarning: boolean;

  /**
   * `true` when the feed is older than 90 days. The engine MUST NOT
   * enter Dead_Reckoning mode while this flag is set. The UI should
   * inform the user that tunnel/signal-loss handling is degraded.
   *
   * @see Requirement 18.4
   */
  readonly drDisabled: boolean;

  /** The computed feed age in days (for display purposes). */
  readonly feedAgeDays: number;
}

/**
 * UI-facing warning descriptor surfaced when the GTFS feed is stale or
 * DR is disabled. Consumers can pattern-match on `severity` to decide
 * how prominently to render the warning.
 */
export interface GtfsAgeWarning {
  /** `'stale'` for > 30 days; `'dr-disabled'` for > 90 days. */
  readonly severity: 'stale' | 'dr-disabled';
  /** Human-readable message suitable for display in a toast or banner. */
  readonly message: string;
  /** Feed age in whole days (floored). */
  readonly ageDays: number;
}

/**
 * Evaluate the GTFS feed age policy for a given feed.
 *
 * @param feed - The GTFS feed to evaluate.
 * @param opts - Optional `now` override for testing.
 * @returns The policy result with `staleWarning` and `drDisabled` flags.
 */
export function evaluateGtfsAgePolicy(feed: GtfsFeed, opts: FeedAgeOptions = {}): GtfsAgePolicy {
  const ageDays = feed.feedAgeDays(opts);
  return {
    staleWarning: ageDays > STALE_WARNING_DAYS,
    drDisabled: ageDays > DR_DISABLED_DAYS,
    feedAgeDays: ageDays,
  };
}

/**
 * Derive a UI warning from the age policy, or `null` when the feed is
 * fresh enough that no warning is needed.
 *
 * When `drDisabled` is true the returned severity is `'dr-disabled'`
 * (the stronger warning); otherwise if `staleWarning` is true the
 * severity is `'stale'`.
 *
 * @param policy - The result of `evaluateGtfsAgePolicy(...)`.
 * @returns A warning descriptor, or `null` if no warning is needed.
 */
export function gtfsAgeWarning(policy: GtfsAgePolicy): GtfsAgeWarning | null {
  if (policy.drDisabled) {
    return {
      severity: 'dr-disabled',
      message:
        `GTFS schedule data is ${Math.floor(policy.feedAgeDays)} days old. ` +
        `Tunnel and signal-loss handling (Dead Reckoning) is disabled. ` +
        `Connect to WiFi to update.`,
      ageDays: Math.floor(policy.feedAgeDays),
    };
  }
  if (policy.staleWarning) {
    return {
      severity: 'stale',
      message:
        `GTFS schedule data is ${Math.floor(policy.feedAgeDays)} days old. ` +
        `Schedule-based features may be inaccurate. ` +
        `Connect to WiFi to update.`,
      ageDays: Math.floor(policy.feedAgeDays),
    };
  }
  return null;
}
