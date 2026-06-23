// Storage budget enforcement, LRU eviction, and storage UI data source.
//
// design.md "### Storage_Manager" owns the LRU access timestamps and
// bytes-used tracking. This module layers budget policy on top of the
// `lru_access` table and the `StorageManager` primitives.
//
// Validates: Requirements 19.1, 19.2, 19.3, 19.4, 19.5

import * as fs from 'node:fs/promises';

import type { StorageManager } from './manager';
import type { PackRef } from './paths';
import { packsRoot } from './paths';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Eviction mode configured by the user. */
export type EvictionMode = 'manual' | 'auto';

/** Configuration for the storage budget. */
export interface StorageBudgetConfig {
  /** Maximum bytes allowed for Offline_Packs. Default: 2 GB. */
  budgetBytes: number;
  /** Eviction mode: 'manual' prompts the user; 'auto' evicts LRU packs. */
  evictionMode: EvictionMode;
}

/** Default budget: 2 GB (Req 19.1). */
export const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

/** Summary exposed to the storage management screen (Req 19.5). */
export interface StorageUsageSummary {
  /** Total bytes used by all installed Offline_Packs. */
  usedBytes: number;
  /** Remaining bytes before the budget ceiling is reached. */
  remainingBytes: number;
  /** The configured budget ceiling in bytes. */
  budgetBytes: number;
  /** Per-pack breakdown, ordered by last access (most recent first). */
  packs: ReadonlyArray<PackUsageEntry>;
}

/** Per-pack entry for the storage management screen. */
export interface PackUsageEntry {
  bundleId: string;
  version: string;
  bytesUsed: number;
  lastAccessUtc: number;
}

/**
 * Result of a budget check before downloading a new pack.
 *
 * - `ok`: budget has room, proceed with download.
 * - `over-budget-manual`: budget would be exceeded; user must decide.
 * - `over-budget-evicted`: auto-evict freed enough space; proceed.
 * - `over-budget-blocked`: auto-evict could not free enough space
 *   (e.g., only the active-tour pack remains).
 */
export type BudgetCheckResult =
  | { readonly outcome: 'ok' }
  | { readonly outcome: 'over-budget-manual'; readonly overageBytes: number }
  | { readonly outcome: 'over-budget-evicted'; readonly evictedPacks: ReadonlyArray<PackRef> }
  | { readonly outcome: 'over-budget-blocked'; readonly overageBytes: number };

// ---------------------------------------------------------------------------
// Active-tour guard
// ---------------------------------------------------------------------------

/**
 * Callback that returns the `PackRef` of the currently active tour, or
 * `null` if no tour is running. The budget enforcer calls this before
 * evicting any pack to satisfy Req 19.4 ("never evict the active-tour
 * pack").
 *
 * Production wiring reads from the Tour_Engine state; tests inject a
 * simple stub.
 */
export type ActiveTourProvider = () => PackRef | null;

// ---------------------------------------------------------------------------
// StorageBudget
// ---------------------------------------------------------------------------

export interface StorageBudgetOptions {
  storage: StorageManager;
  config: StorageBudgetConfig;
  activeTourProvider: ActiveTourProvider;
}

/**
 * Storage budget enforcer and LRU evictor.
 *
 * Composed on top of `StorageManager` (same pattern as the downloader).
 * Reads and writes the `lru_access` table for per-pack byte tracking and
 * last-access timestamps.
 */
export class StorageBudget {
  private readonly storage: StorageManager;
  private config: StorageBudgetConfig;
  private readonly activeTourProvider: ActiveTourProvider;

  constructor(opts: StorageBudgetOptions) {
    this.storage = opts.storage;
    this.config = { ...opts.config };
    this.activeTourProvider = opts.activeTourProvider;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** Update the budget ceiling (Req 19.1). */
  setBudgetBytes(bytes: number): void {
    if (bytes < 0) {
      throw new RangeError('budgetBytes must be non-negative');
    }
    this.config = { ...this.config, budgetBytes: bytes };
  }

  /** Update the eviction mode. */
  setEvictionMode(mode: EvictionMode): void {
    this.config = { ...this.config, evictionMode: mode };
  }

  /** Current configuration snapshot. */
  getConfig(): Readonly<StorageBudgetConfig> {
    return { ...this.config };
  }

  // -------------------------------------------------------------------------
  // LRU access tracking
  // -------------------------------------------------------------------------

  /**
   * Record that a pack was accessed (e.g., tour started, user viewed it).
   * Updates `lru_access.last_access_utc` and `bytes_used`.
   */
  async touchPack(ref: PackRef, bytesUsed: number): Promise<void> {
    await this.storage.driver.run(
      `INSERT INTO lru_access (bundle_id, version, last_access_utc, bytes_used)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bundle_id, version) DO UPDATE SET
         last_access_utc = excluded.last_access_utc,
         bytes_used      = excluded.bytes_used`,
      [ref.bundleId, ref.version, Date.now(), bytesUsed],
    );
  }

  /**
   * Register a newly downloaded pack in the LRU table. Called by the
   * downloader after a successful promotion.
   */
  async registerPack(ref: PackRef, bytesUsed: number): Promise<void> {
    await this.touchPack(ref, bytesUsed);
  }

  /**
   * Remove a pack's LRU entry (called after eviction/deletion).
   */
  async unregisterPack(ref: PackRef): Promise<void> {
    await this.storage.driver.run(
      `DELETE FROM lru_access WHERE bundle_id = ? AND version = ?`,
      [ref.bundleId, ref.version],
    );
  }

  // -------------------------------------------------------------------------
  // Budget check (Req 19.2, 19.3)
  // -------------------------------------------------------------------------

  /**
   * Check whether downloading a pack of `newPackBytes` would exceed the
   * budget. If so, either prompt the user (manual mode) or auto-evict
   * LRU packs (auto mode).
   *
   * Returns the outcome so the caller can decide how to proceed.
   */
  async checkBudget(newPackBytes: number): Promise<BudgetCheckResult> {
    const totalUsed = await this.totalUsedBytes();
    const projectedUsage = totalUsed + newPackBytes;

    if (projectedUsage <= this.config.budgetBytes) {
      return { outcome: 'ok' };
    }

    const overageBytes = projectedUsage - this.config.budgetBytes;

    if (this.config.evictionMode === 'manual') {
      // Req 19.2: prompt the user to raise budget or select packs to remove.
      return { outcome: 'over-budget-manual', overageBytes };
    }

    // Auto-evict mode (Req 19.3): evict LRU packs until budget is satisfied.
    const evicted = await this.evictUntilFits(newPackBytes);
    if (evicted === null) {
      // Could not free enough space (only active-tour pack remains).
      const currentUsed = await this.totalUsedBytes();
      return {
        outcome: 'over-budget-blocked',
        overageBytes: currentUsed + newPackBytes - this.config.budgetBytes,
      };
    }

    return { outcome: 'over-budget-evicted', evictedPacks: evicted };
  }

  // -------------------------------------------------------------------------
  // Eviction (Req 19.3, 19.4)
  // -------------------------------------------------------------------------

  /**
   * Evict least-recently-used packs until `newPackBytes` fits within the
   * budget. Never evicts the active-tour pack (Req 19.4).
   *
   * Returns the list of evicted packs, or `null` if eviction could not
   * free enough space.
   */
  async evictUntilFits(newPackBytes: number): Promise<ReadonlyArray<PackRef> | null> {
    const evicted: PackRef[] = [];

    // Loop: check if budget is satisfied, if not evict the LRU pack.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const totalUsed = await this.totalUsedBytes();
      if (totalUsed + newPackBytes <= this.config.budgetBytes) {
        return evicted;
      }

      const candidate = await this.leastRecentlyUsedEvictable();
      if (candidate === null) {
        // No more evictable packs — cannot satisfy the budget.
        return null;
      }

      await this.evictPack(candidate);
      evicted.push(candidate);
    }
  }

  /**
   * Evict a specific pack: remove its directory from disk and its
   * `lru_access` row. Also cleans up `pack_progress` rows.
   */
  async evictPack(ref: PackRef): Promise<void> {
    // Remove from disk.
    const dir = this.storage.packDir(ref);
    await fs.rm(dir, { recursive: true, force: true });

    // Remove LRU tracking row.
    await this.unregisterPack(ref);

    // Remove pack_progress rows.
    await this.storage.driver.run(
      `DELETE FROM pack_progress WHERE bundle_id = ? AND version = ?`,
      [ref.bundleId, ref.version],
    );
  }

  /**
   * Find the least-recently-used pack that is NOT the active-tour pack.
   * Returns `null` if no evictable pack exists.
   */
  private async leastRecentlyUsedEvictable(): Promise<PackRef | null> {
    const activePack = this.activeTourProvider();

    // Query all packs ordered by last access (oldest first).
    const rows = await this.storage.driver.all<{
      bundle_id: string;
      version: string;
    }>(
      `SELECT bundle_id, version FROM lru_access ORDER BY last_access_utc ASC`,
    );

    for (const row of rows) {
      // Never evict the active-tour pack (Req 19.4).
      if (
        activePack !== null &&
        row.bundle_id === activePack.bundleId &&
        row.version === activePack.version
      ) {
        continue;
      }
      return { bundleId: row.bundle_id, version: row.version };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Storage UI data source (Req 19.5)
  // -------------------------------------------------------------------------

  /**
   * Total bytes used by all installed Offline_Packs.
   */
  async totalUsedBytes(): Promise<number> {
    const row = await this.storage.driver.get<{ total: number | null }>(
      `SELECT SUM(bytes_used) AS total FROM lru_access`,
    );
    return row?.total ?? 0;
  }

  /**
   * Remaining bytes before the budget ceiling is reached.
   */
  async remainingBytes(): Promise<number> {
    const used = await this.totalUsedBytes();
    return Math.max(0, this.config.budgetBytes - used);
  }

  /**
   * Full usage summary for the storage management screen (Req 19.5).
   */
  async getUsageSummary(): Promise<StorageUsageSummary> {
    const usedBytes = await this.totalUsedBytes();
    const remainingBytes = Math.max(0, this.config.budgetBytes - usedBytes);

    const rows = await this.storage.driver.all<{
      bundle_id: string;
      version: string;
      bytes_used: number;
      last_access_utc: number;
    }>(
      `SELECT bundle_id, version, bytes_used, last_access_utc
       FROM lru_access
       ORDER BY last_access_utc DESC`,
    );

    const packs: PackUsageEntry[] = rows.map((r) => ({
      bundleId: r.bundle_id,
      version: r.version,
      bytesUsed: r.bytes_used,
      lastAccessUtc: r.last_access_utc,
    }));

    return {
      usedBytes,
      remainingBytes,
      budgetBytes: this.config.budgetBytes,
      packs,
    };
  }
}
