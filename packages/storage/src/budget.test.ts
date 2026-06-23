// Unit tests for StorageBudget: budget enforcement, LRU eviction, and
// storage UI data source.
//
// Validates: Requirements 19.1, 19.2, 19.3, 19.4, 19.5

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { StorageManager } from './manager';
import { betterSqliteDriver } from './sqlite';
import {
  StorageBudget,
  DEFAULT_BUDGET_BYTES,
  type ActiveTourProvider,
  type StorageBudgetConfig,
} from './budget';
import type { PackRef } from './paths';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setup(opts?: {
  config?: Partial<StorageBudgetConfig>;
  activeTourProvider?: ActiveTourProvider;
}): Promise<{
  budget: StorageBudget;
  storage: StorageManager;
  docs: string;
  raw: Database.Database;
}> {
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-budget-'));
  const raw = new Database(':memory:');
  const storage = await StorageManager.open({
    layout: { docsDir: docs },
    driver: betterSqliteDriver(raw),
  });

  const config: StorageBudgetConfig = {
    budgetBytes: opts?.config?.budgetBytes ?? DEFAULT_BUDGET_BYTES,
    evictionMode: opts?.config?.evictionMode ?? 'auto',
  };

  const budget = new StorageBudget({
    storage,
    config,
    activeTourProvider: opts?.activeTourProvider ?? (() => null),
  });

  return { budget, storage, docs, raw };
}

async function teardown(storage: StorageManager, docs: string): Promise<void> {
  await storage.close();
  await fs.rm(docs, { recursive: true, force: true });
}

/** Create a fake pack directory so eviction has something to remove. */
async function createFakePackDir(storage: StorageManager, ref: PackRef): Promise<void> {
  const dir = storage.packDir(ref);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), '{}');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StorageBudget — configuration', () => {
  it('defaults to 2 GB budget', () => {
    expect(DEFAULT_BUDGET_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it('allows updating the budget ceiling (Req 19.1)', async () => {
    const { budget, storage, docs } = await setup();
    try {
      expect(budget.getConfig().budgetBytes).toBe(DEFAULT_BUDGET_BYTES);
      budget.setBudgetBytes(1024 * 1024 * 500); // 500 MB
      expect(budget.getConfig().budgetBytes).toBe(1024 * 1024 * 500);
    } finally {
      await teardown(storage, docs);
    }
  });

  it('rejects negative budget', async () => {
    const { budget, storage, docs } = await setup();
    try {
      expect(() => budget.setBudgetBytes(-1)).toThrow(RangeError);
    } finally {
      await teardown(storage, docs);
    }
  });

  it('allows switching eviction mode', async () => {
    const { budget, storage, docs } = await setup();
    try {
      budget.setEvictionMode('manual');
      expect(budget.getConfig().evictionMode).toBe('manual');
      budget.setEvictionMode('auto');
      expect(budget.getConfig().evictionMode).toBe('auto');
    } finally {
      await teardown(storage, docs);
    }
  });
});

describe('StorageBudget — LRU tracking', () => {
  it('registers and tracks pack usage', async () => {
    const { budget, storage, docs } = await setup();
    try {
      const ref: PackRef = { bundleId: 'city-tour', version: '1.0.0' };
      await budget.registerPack(ref, 100_000_000);

      const summary = await budget.getUsageSummary();
      expect(summary.usedBytes).toBe(100_000_000);
      expect(summary.packs).toHaveLength(1);
      const pack0 = summary.packs[0]!;
      expect(pack0.bundleId).toBe('city-tour');
      expect(pack0.version).toBe('1.0.0');
      expect(pack0.bytesUsed).toBe(100_000_000);
    } finally {
      await teardown(storage, docs);
    }
  });

  it('touchPack updates last_access_utc', async () => {
    const { budget, storage, docs } = await setup();
    try {
      const ref: PackRef = { bundleId: 'city-tour', version: '1.0.0' };
      await budget.registerPack(ref, 50_000_000);

      const before = (await budget.getUsageSummary()).packs[0]!.lastAccessUtc;

      // Small delay to ensure timestamp differs.
      await new Promise((r) => setTimeout(r, 10));
      await budget.touchPack(ref, 50_000_000);

      const after = (await budget.getUsageSummary()).packs[0]!.lastAccessUtc;
      expect(after).toBeGreaterThanOrEqual(before);
    } finally {
      await teardown(storage, docs);
    }
  });

  it('unregisterPack removes the entry', async () => {
    const { budget, storage, docs } = await setup();
    try {
      const ref: PackRef = { bundleId: 'city-tour', version: '1.0.0' };
      await budget.registerPack(ref, 50_000_000);
      await budget.unregisterPack(ref);

      expect(await budget.totalUsedBytes()).toBe(0);
    } finally {
      await teardown(storage, docs);
    }
  });
});

describe('StorageBudget — budget check (Req 19.2)', () => {
  it('returns ok when new pack fits within budget', async () => {
    const { budget, storage, docs } = await setup({
      config: { budgetBytes: 500_000_000 },
    });
    try {
      await budget.registerPack({ bundleId: 'a', version: '1' }, 100_000_000);
      const result = await budget.checkBudget(200_000_000);
      expect(result.outcome).toBe('ok');
    } finally {
      await teardown(storage, docs);
    }
  });

  it('returns over-budget-manual in manual mode (Req 19.2)', async () => {
    const { budget, storage, docs } = await setup({
      config: { budgetBytes: 500_000_000, evictionMode: 'manual' },
    });
    try {
      await budget.registerPack({ bundleId: 'a', version: '1' }, 400_000_000);
      const result = await budget.checkBudget(200_000_000);
      expect(result.outcome).toBe('over-budget-manual');
      if (result.outcome === 'over-budget-manual') {
        expect(result.overageBytes).toBe(100_000_000);
      }
    } finally {
      await teardown(storage, docs);
    }
  });

  it('auto-evicts LRU packs in auto mode (Req 19.3)', async () => {
    const { budget, storage, docs } = await setup({
      config: { budgetBytes: 500_000_000, evictionMode: 'auto' },
    });
    try {
      const refA: PackRef = { bundleId: 'a', version: '1' };
      const refB: PackRef = { bundleId: 'b', version: '1' };

      await createFakePackDir(storage, refA);
      await createFakePackDir(storage, refB);

      // Register A first (older), then B (newer).
      await budget.registerPack(refA, 200_000_000);
      await new Promise((r) => setTimeout(r, 10));
      await budget.registerPack(refB, 200_000_000);

      // New pack of 200 MB would push total to 600 MB > 500 MB budget.
      const result = await budget.checkBudget(200_000_000);
      expect(result.outcome).toBe('over-budget-evicted');
      if (result.outcome === 'over-budget-evicted') {
        // Should have evicted pack A (least recently used).
        expect(result.evictedPacks).toEqual([refA]);
      }

      // After eviction, total should be 200 MB (only B remains).
      expect(await budget.totalUsedBytes()).toBe(200_000_000);
    } finally {
      await teardown(storage, docs);
    }
  });
});

describe('StorageBudget — never evict active-tour pack (Req 19.4)', () => {
  it('skips the active-tour pack during eviction', async () => {
    const activeRef: PackRef = { bundleId: 'active', version: '1' };
    const { budget, storage, docs } = await setup({
      config: { budgetBytes: 500_000_000, evictionMode: 'auto' },
      activeTourProvider: () => activeRef,
    });
    try {
      const refOther: PackRef = { bundleId: 'other', version: '1' };

      await createFakePackDir(storage, activeRef);
      await createFakePackDir(storage, refOther);

      // Active pack is oldest (registered first).
      await budget.registerPack(activeRef, 200_000_000);
      await new Promise((r) => setTimeout(r, 10));
      await budget.registerPack(refOther, 200_000_000);

      // New pack of 200 MB would exceed budget. Active pack is LRU but
      // must NOT be evicted.
      const result = await budget.checkBudget(200_000_000);
      expect(result.outcome).toBe('over-budget-evicted');
      if (result.outcome === 'over-budget-evicted') {
        // Should evict 'other' instead of 'active'.
        expect(result.evictedPacks).toEqual([refOther]);
      }

      // Active pack should still be registered.
      const summary = await budget.getUsageSummary();
      expect(summary.packs).toHaveLength(1);
      expect(summary.packs[0]!.bundleId).toBe('active');
    } finally {
      await teardown(storage, docs);
    }
  });

  it('returns over-budget-blocked when only active-tour pack remains', async () => {
    const activeRef: PackRef = { bundleId: 'active', version: '1' };
    const { budget, storage, docs } = await setup({
      config: { budgetBytes: 300_000_000, evictionMode: 'auto' },
      activeTourProvider: () => activeRef,
    });
    try {
      await createFakePackDir(storage, activeRef);
      await budget.registerPack(activeRef, 250_000_000);

      // New pack of 100 MB would exceed 300 MB budget, and the only
      // existing pack is the active tour — cannot evict.
      const result = await budget.checkBudget(100_000_000);
      expect(result.outcome).toBe('over-budget-blocked');
      if (result.outcome === 'over-budget-blocked') {
        expect(result.overageBytes).toBe(50_000_000);
      }
    } finally {
      await teardown(storage, docs);
    }
  });
});

describe('StorageBudget — eviction removes pack from disk', () => {
  it('evictPack removes the directory and all tracking rows', async () => {
    const { budget, storage, docs } = await setup();
    try {
      const ref: PackRef = { bundleId: 'evict-me', version: '2.0.0' };
      await createFakePackDir(storage, ref);
      await budget.registerPack(ref, 150_000_000);

      // Also seed a pack_progress row to verify cleanup.
      await storage.driver.run(
        `INSERT INTO pack_progress
           (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
         VALUES (?, ?, ?, 'complete', 1000, 1000, 'abc', ?)`,
        ['evict-me', '2.0.0', 'manifest.json', Date.now()],
      );

      await budget.evictPack(ref);

      // Directory should be gone.
      await expect(fs.access(storage.packDir(ref))).rejects.toThrow();

      // LRU row should be gone.
      expect(await budget.totalUsedBytes()).toBe(0);

      // pack_progress rows should be gone.
      const rows = await storage.driver.all(
        `SELECT * FROM pack_progress WHERE bundle_id = ? AND version = ?`,
        ['evict-me', '2.0.0'],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await teardown(storage, docs);
    }
  });
});

describe('StorageBudget — storage UI data source (Req 19.5)', () => {
  it('exposes total used and remaining bytes', async () => {
    const { budget, storage, docs } = await setup({
      config: { budgetBytes: 1_000_000_000 },
    });
    try {
      await budget.registerPack({ bundleId: 'a', version: '1' }, 300_000_000);
      await budget.registerPack({ bundleId: 'b', version: '1' }, 200_000_000);

      const summary = await budget.getUsageSummary();
      expect(summary.usedBytes).toBe(500_000_000);
      expect(summary.remainingBytes).toBe(500_000_000);
      expect(summary.budgetBytes).toBe(1_000_000_000);
    } finally {
      await teardown(storage, docs);
    }
  });

  it('lists packs ordered by most recent access first', async () => {
    const { budget, storage, docs } = await setup();
    try {
      await budget.registerPack({ bundleId: 'old', version: '1' }, 100_000_000);
      await new Promise((r) => setTimeout(r, 10));
      await budget.registerPack({ bundleId: 'new', version: '1' }, 100_000_000);

      const summary = await budget.getUsageSummary();
      expect(summary.packs[0]!.bundleId).toBe('new');
      expect(summary.packs[1]!.bundleId).toBe('old');
    } finally {
      await teardown(storage, docs);
    }
  });

  it('remainingBytes never goes negative', async () => {
    const { budget, storage, docs } = await setup({
      config: { budgetBytes: 100_000_000 },
    });
    try {
      // Register a pack larger than the budget (e.g., budget was lowered
      // after the pack was already downloaded).
      await budget.registerPack({ bundleId: 'big', version: '1' }, 200_000_000);

      const remaining = await budget.remainingBytes();
      expect(remaining).toBe(0);

      const summary = await budget.getUsageSummary();
      expect(summary.remainingBytes).toBe(0);
    } finally {
      await teardown(storage, docs);
    }
  });
});
