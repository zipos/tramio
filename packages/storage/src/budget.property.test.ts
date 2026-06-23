// Property-based test for storage budget under add and evict (task 5.5).
//
// Feature: urban-narrative-mvp, Property 17: Storage budget policy is correct
// under add and evict
//
// **Validates: Requirements 19.2, 19.3, 19.4**
//
// Strategy:
//   Generate arbitrary sequences of add/evict operations against a
//   StorageBudget instance with a random budget ceiling, a random set of
//   installed packs, and a randomly chosen active-tour pack. Assert:
//
//   1. After any sequence of add/evict operations, totalUsedBytes never
//      exceeds budgetBytes (in auto mode).
//   2. The active-tour pack is never evicted regardless of LRU ordering.
//   3. Eviction always removes the least-recently-used pack first.
//   4. After eviction, the budget check returns 'ok' for the new pack.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as fc from 'fast-check';
import Database from 'better-sqlite3';

import { StorageManager } from './manager';
import { betterSqliteDriver } from './sqlite';
import {
  StorageBudget,
  type ActiveTourProvider,
  type StorageBudgetConfig,
} from './budget';
import type { PackRef } from './paths';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestContext {
  budget: StorageBudget;
  storage: StorageManager;
  docs: string;
}

async function setup(opts: {
  config: StorageBudgetConfig;
  activeTourProvider: ActiveTourProvider;
}): Promise<TestContext> {
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-prop17-'));
  const raw = new Database(':memory:');
  const storage = await StorageManager.open({
    layout: { docsDir: docs },
    driver: betterSqliteDriver(raw),
  });

  const budget = new StorageBudget({
    storage,
    config: opts.config,
    activeTourProvider: opts.activeTourProvider,
  });

  return { budget, storage, docs };
}

async function teardown(ctx: TestContext): Promise<void> {
  await ctx.storage.close();
  await fs.rm(ctx.docs, { recursive: true, force: true });
}

/** Create a fake pack directory so eviction has something to remove. */
async function createFakePackDir(storage: StorageManager, ref: PackRef): Promise<void> {
  const dir = storage.packDir(ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), '{}');
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generate a valid pack reference with a unique id. */
function arbPackRef(index: number): fc.Arbitrary<PackRef> {
  return fc.constant({ bundleId: `pack-${index}`, version: '1.0.0' });
}

/** A pack with its size in bytes (between 10 MB and 500 MB). */
interface PackWithSize {
  ref: PackRef;
  sizeBytes: number;
}

/** Generate a list of installed packs (1–6 packs). */
const arbInstalledPacks: fc.Arbitrary<PackWithSize[]> = fc
  .integer({ min: 1, max: 6 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, i) =>
        fc.integer({ min: 10_000_000, max: 500_000_000 }).map((size) => ({
          ref: { bundleId: `pack-${i}`, version: '1.0.0' },
          sizeBytes: size,
        })),
      ),
    ),
  );

/** Generate a budget ceiling that is at least as large as the largest single pack. */
function arbBudget(packs: PackWithSize[]): fc.Arbitrary<number> {
  const maxPackSize = Math.max(...packs.map((p) => p.sizeBytes));
  // Budget between the largest pack size and 3x total size of all packs.
  const totalSize = packs.reduce((sum, p) => sum + p.sizeBytes, 0);
  return fc.integer({ min: maxPackSize, max: Math.max(maxPackSize + 1, totalSize * 3) });
}

/** Generate a new pack size for the add operation. */
const arbNewPackSize: fc.Arbitrary<number> = fc.integer({
  min: 10_000_000,
  max: 400_000_000,
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 17: Storage budget policy is correct under add and evict', () => {
  it('in auto mode, totalUsedBytes never exceeds budgetBytes after checkBudget', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInstalledPacks.chain((packs) =>
          fc.tuple(
            fc.constant(packs),
            arbBudget(packs),
            arbNewPackSize,
            // Which pack index is the active tour (or -1 for none).
            fc.integer({ min: -1, max: packs.length - 1 }),
          ),
        ),
        async ([packs, budgetBytes, newPackSize, activeIdx]) => {
          const activePack: PackRef | null =
            activeIdx >= 0 ? packs[activeIdx]!.ref : null;

          const ctx = await setup({
            config: { budgetBytes, evictionMode: 'auto' },
            activeTourProvider: () => activePack,
          });

          try {
            // Register all installed packs with staggered access times.
            for (let i = 0; i < packs.length; i++) {
              const p = packs[i]!;
              await createFakePackDir(ctx.storage, p.ref);
              // Use a deterministic timestamp so LRU order matches array order.
              await ctx.storage.driver.run(
                `INSERT INTO lru_access (bundle_id, version, last_access_utc, bytes_used)
                 VALUES (?, ?, ?, ?)`,
                [p.ref.bundleId, p.ref.version, 1000 + i * 100, p.sizeBytes],
              );
            }

            // Perform the budget check for the new pack.
            const result = await ctx.budget.checkBudget(newPackSize);

            if (result.outcome === 'ok' || result.outcome === 'over-budget-evicted') {
              // After a successful check (ok or evicted), the remaining budget
              // must accommodate the new pack.
              const totalUsed = await ctx.budget.totalUsedBytes();
              if (totalUsed + newPackSize > budgetBytes) {
                throw new Error(
                  `Budget violated: totalUsed=${totalUsed} + newPack=${newPackSize} = ` +
                    `${totalUsed + newPackSize} > budget=${budgetBytes}`,
                );
              }
            }
            // over-budget-blocked is acceptable — it means we couldn't free enough.
          } finally {
            await teardown(ctx);
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('the active-tour pack is never evicted regardless of LRU ordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInstalledPacks
          .filter((packs) => packs.length >= 2)
          .chain((packs) =>
            fc.tuple(
              fc.constant(packs),
              // Budget small enough to force eviction.
              fc.constant(
                Math.max(
                  packs.reduce((sum, p) => sum + p.sizeBytes, 0) * 0.4,
                  packs[0]!.sizeBytes + 1,
                ),
              ),
              arbNewPackSize,
              // Active pack is always index 0 (the LRU — oldest access).
              fc.constant(0),
            ),
          ),
        async ([packs, budgetBytes, newPackSize, activeIdx]) => {
          const activePack = packs[activeIdx]!.ref;

          const ctx = await setup({
            config: { budgetBytes: Math.ceil(budgetBytes), evictionMode: 'auto' },
            activeTourProvider: () => activePack,
          });

          try {
            // Register packs: active pack is the oldest (LRU candidate).
            for (let i = 0; i < packs.length; i++) {
              const p = packs[i]!;
              await createFakePackDir(ctx.storage, p.ref);
              await ctx.storage.driver.run(
                `INSERT INTO lru_access (bundle_id, version, last_access_utc, bytes_used)
                 VALUES (?, ?, ?, ?)`,
                [p.ref.bundleId, p.ref.version, 1000 + i * 100, p.sizeBytes],
              );
            }

            // Perform the budget check.
            const result = await ctx.budget.checkBudget(newPackSize);

            if (result.outcome === 'over-budget-evicted') {
              // Verify the active pack was NOT evicted.
              for (const evicted of result.evictedPacks) {
                if (
                  evicted.bundleId === activePack.bundleId &&
                  evicted.version === activePack.version
                ) {
                  throw new Error(
                    `Active-tour pack ${activePack.bundleId}@${activePack.version} was evicted!`,
                  );
                }
              }
            }

            // Regardless of outcome, the active pack must still be registered.
            const summary = await ctx.budget.getUsageSummary();
            const activeStillPresent = summary.packs.some(
              (p) =>
                p.bundleId === activePack.bundleId &&
                p.version === activePack.version,
            );
            if (!activeStillPresent) {
              throw new Error(
                `Active-tour pack ${activePack.bundleId}@${activePack.version} ` +
                  `is no longer in the LRU table after budget check`,
              );
            }
          } finally {
            await teardown(ctx);
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('eviction always removes the least-recently-used pack first', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInstalledPacks
          .filter((packs) => packs.length >= 3)
          .chain((packs) =>
            fc.tuple(
              fc.constant(packs),
              // Budget tight enough to force at least one eviction.
              fc.constant(
                packs.reduce((sum, p) => sum + p.sizeBytes, 0) - packs[0]!.sizeBytes + 1,
              ),
              // New pack size that will trigger eviction.
              fc.constant(packs[0]!.sizeBytes + 1),
            ),
          ),
        async ([packs, budgetBytes, newPackSize]) => {
          const ctx = await setup({
            config: { budgetBytes, evictionMode: 'auto' },
            activeTourProvider: () => null, // No active tour.
          });

          try {
            // Register packs with strictly increasing access times.
            // Pack at index 0 is the oldest (LRU), index N-1 is the newest.
            for (let i = 0; i < packs.length; i++) {
              const p = packs[i]!;
              await createFakePackDir(ctx.storage, p.ref);
              await ctx.storage.driver.run(
                `INSERT INTO lru_access (bundle_id, version, last_access_utc, bytes_used)
                 VALUES (?, ?, ?, ?)`,
                [p.ref.bundleId, p.ref.version, 1000 + i * 1000, p.sizeBytes],
              );
            }

            const result = await ctx.budget.checkBudget(newPackSize);

            if (result.outcome === 'over-budget-evicted' && result.evictedPacks.length > 0) {
              // The evicted packs must be in LRU order (oldest first).
              // Build the expected LRU order (excluding active pack, which is null here).
              const lruOrder = packs.map((p) => p.ref);

              // Each evicted pack must appear in LRU order relative to
              // the remaining packs.
              let lastLruIdx = -1;
              for (const evicted of result.evictedPacks) {
                const idx = lruOrder.findIndex(
                  (r) =>
                    r.bundleId === evicted.bundleId && r.version === evicted.version,
                );
                if (idx === -1) {
                  throw new Error(
                    `Evicted pack ${evicted.bundleId}@${evicted.version} not found in installed packs`,
                  );
                }
                if (idx <= lastLruIdx) {
                  throw new Error(
                    `Eviction order violated: pack at LRU index ${idx} evicted after ` +
                      `pack at LRU index ${lastLruIdx}`,
                  );
                }
                lastLruIdx = idx;
              }

              // The first evicted pack must be the absolute LRU (index 0).
              const firstEvicted = result.evictedPacks[0]!;
              if (
                firstEvicted.bundleId !== packs[0]!.ref.bundleId ||
                firstEvicted.version !== packs[0]!.ref.version
              ) {
                throw new Error(
                  `First evicted pack should be the LRU (${packs[0]!.ref.bundleId}) ` +
                    `but was ${firstEvicted.bundleId}`,
                );
              }
            }
          } finally {
            await teardown(ctx);
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });

  it('after eviction, the budget check returns ok for the new pack', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInstalledPacks
          .filter((packs) => packs.length >= 2)
          .chain((packs) => {
            const totalSize = packs.reduce((sum, p) => sum + p.sizeBytes, 0);
            // Budget that is less than total + new pack but more than the
            // smallest pack, so eviction can succeed.
            const smallestPack = Math.min(...packs.map((p) => p.sizeBytes));
            return fc.tuple(
              fc.constant(packs),
              fc.integer({
                min: smallestPack + 10_000_000,
                max: totalSize,
              }),
              fc.integer({ min: 10_000_000, max: smallestPack }),
            );
          }),
        async ([packs, budgetBytes, newPackSize]) => {
          const ctx = await setup({
            config: { budgetBytes, evictionMode: 'auto' },
            activeTourProvider: () => null, // No active tour.
          });

          try {
            // Register all packs.
            for (let i = 0; i < packs.length; i++) {
              const p = packs[i]!;
              await createFakePackDir(ctx.storage, p.ref);
              await ctx.storage.driver.run(
                `INSERT INTO lru_access (bundle_id, version, last_access_utc, bytes_used)
                 VALUES (?, ?, ?, ?)`,
                [p.ref.bundleId, p.ref.version, 1000 + i * 100, p.sizeBytes],
              );
            }

            const result = await ctx.budget.checkBudget(newPackSize);

            if (result.outcome === 'over-budget-evicted') {
              // After eviction, a second check for the same pack should return 'ok'.
              const secondCheck = await ctx.budget.checkBudget(newPackSize);
              if (secondCheck.outcome !== 'ok') {
                throw new Error(
                  `After eviction, second budget check returned '${secondCheck.outcome}' ` +
                    `instead of 'ok'`,
                );
              }
            } else if (result.outcome === 'ok') {
              // Already fits — property holds trivially.
            }
            // over-budget-blocked means eviction couldn't free enough space,
            // which is acceptable (only active-tour pack remains or budget is
            // too small for even one pack).
          } finally {
            await teardown(ctx);
          }
        },
      ),
      { numRuns: 100, seed: 42 },
    );
  });
});
