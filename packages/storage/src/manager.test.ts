// End-to-end tests for the StorageManager facade: the layout helpers
// surface the right paths, the SQLite schema is installed by `open()`,
// and stage+rename / SHA-256 verify work against a real tmp directory.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { StorageManager } from './manager';
import { betterSqliteDriver } from './sqlite';
import { SCHEMA_VERSION } from './schema';

interface CountRow {
  n: number;
}

interface PackProgressRow {
  bundle_id: string;
  version: string;
  asset_path: string;
  status: string;
}

async function openManager(): Promise<{
  manager: StorageManager;
  docs: string;
  raw: Database.Database;
}> {
  const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-storage-mgr-'));
  const raw = new Database(':memory:');
  const manager = await StorageManager.open({
    layout: { docsDir: docs },
    driver: betterSqliteDriver(raw),
  });
  return { manager, docs, raw };
}

async function closeManager(m: StorageManager, docs: string): Promise<void> {
  await m.close();
  await fs.rm(docs, { recursive: true, force: true });
}

describe('StorageManager.open', () => {
  it('creates the packs root and installs the schema', async () => {
    const { manager, docs, raw } = await openManager();
    try {
      const root = path.join(docs, 'packs');
      expect((await fs.stat(root)).isDirectory()).toBe(true);
      expect(await manager.schemaVersion()).toBe(SCHEMA_VERSION);

      const tables = raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as ReadonlyArray<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          'pack_progress',
          'entitlement_cache',
          'lru_access',
          'moderation_snapshot',
          'device_id',
          'license_tokens',
        ]),
      );
    } finally {
      await closeManager(manager, docs);
    }
  });

  it('exposes packDir and stagingDir consistent with the layout', async () => {
    const { manager, docs } = await openManager();
    try {
      const ref = { bundleId: 'wroclaw-tram-7', version: '1.4.2' };
      expect(manager.packDir(ref)).toBe(
        path.join(docs, 'packs', 'wroclaw-tram-7', '1.4.2'),
      );
      expect(manager.stagingDir(ref)).toBe(
        path.join(docs, 'packs', 'wroclaw-tram-7', '1.4.2.staging'),
      );
    } finally {
      await closeManager(manager, docs);
    }
  });
});

describe('StorageManager — atomic rename never leaves partials at the final path', () => {
  it('promotes a verified staging file via stage+rename only', async () => {
    const { manager, docs } = await openManager();
    try {
      const ref = { bundleId: 'b', version: '1.0.0' };
      const staging = manager.stagingDir(ref);
      const finalDir = manager.packDir(ref);
      await fs.mkdir(staging, { recursive: true });

      const data = crypto.randomBytes(70_000);
      const expectedSha = crypto.createHash('sha256').update(data).digest('hex');
      const part = path.join(staging, 'asset.bin.part');
      const stagedAsset = path.join(staging, 'asset.bin');
      await fs.writeFile(part, data);

      // Asset is in staging only; final pack dir does not exist yet.
      await expect(fs.access(finalDir)).rejects.toThrow();

      // Verify before promoting `.part` -> staged asset.
      expect(await manager.verifySha256(part, expectedSha)).toBe(true);
      await manager.stageAndRename(part, stagedAsset);

      // Now promote the whole staging directory atomically.
      await manager.stageAndRename(staging, finalDir);

      // Staging is gone, final has the verified bytes, the `.part` file
      // never appears under the final pack dir at any point.
      await expect(fs.access(staging)).rejects.toThrow();
      expect(await fs.readFile(path.join(finalDir, 'asset.bin'))).toEqual(data);
      const finalEntries = await fs.readdir(finalDir, { withFileTypes: true });
      for (const entry of finalEntries) {
        expect(entry.name.endsWith('.part')).toBe(false);
      }
    } finally {
      await closeManager(manager, docs);
    }
  });

  it('rejects a corrupted asset before it is promoted', async () => {
    const { manager, docs } = await openManager();
    try {
      const ref = { bundleId: 'b', version: '1.0.0' };
      const staging = manager.stagingDir(ref);
      await fs.mkdir(staging, { recursive: true });

      const part = path.join(staging, 'asset.bin.part');
      await fs.writeFile(part, Buffer.from('corrupted'));

      // Caller is the downloader: it MUST consult verifySha256 before
      // calling stageAndRename. We simulate that policy here.
      const expectedSha = crypto
        .createHash('sha256')
        .update(Buffer.from('the real payload'))
        .digest('hex');

      const ok = await manager.verifySha256(part, expectedSha);
      expect(ok).toBe(false);

      // Because verification failed, the downloader does NOT call
      // stageAndRename, so the file stays in staging and never appears
      // under the final pack directory.
      await expect(fs.access(manager.packDir(ref))).rejects.toThrow();
    } finally {
      await closeManager(manager, docs);
    }
  });
});

describe('StorageManager — SQLite tables are usable through the driver', () => {
  it('records pack_progress rows and reads them back', async () => {
    const { manager, docs, raw } = await openManager();
    try {
      raw.prepare(
        `INSERT INTO pack_progress
           (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('b', '1', 'manifest.json', 'partial', 1820, 900, null, Date.now());

      const rows = await manager.driver.all<PackProgressRow>(
        `SELECT bundle_id, version, asset_path, status FROM pack_progress`,
      );
      expect(rows).toEqual([
        { bundle_id: 'b', version: '1', asset_path: 'manifest.json', status: 'partial' },
      ]);
    } finally {
      await closeManager(manager, docs);
    }
  });

  it('roundtrips a license_tokens BLOB', async () => {
    const { manager, docs } = await openManager();
    try {
      const jws = new Uint8Array([1, 2, 3, 4, 5]);
      await manager.driver.run(
        `INSERT INTO license_tokens
           (bundle_id, bundle_version, jws, exp_utc, fetched_at_utc)
         VALUES (?, ?, ?, ?, ?)`,
        ['b', '1', jws, 1_736_899_200, 1_735_689_600],
      );
      const row = await manager.driver.get<{ jws: Uint8Array | Buffer }>(
        `SELECT jws FROM license_tokens WHERE bundle_id = ? AND bundle_version = ?`,
        ['b', '1'],
      );
      expect(row).not.toBeNull();
      const blob = row!.jws;
      // better-sqlite3 returns Buffer for BLOB columns; both Buffer and
      // Uint8Array should expose the bytes via index access.
      expect(Array.from(blob as Uint8Array)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      await closeManager(manager, docs);
    }
  });

  it('migrate is idempotent through StorageManager.open', async () => {
    const docs = await fs.mkdtemp(path.join(os.tmpdir(), 'tramio-storage-reopen-'));
    const raw = new Database(':memory:');
    try {
      const m1 = await StorageManager.open({
        layout: { docsDir: docs },
        driver: betterSqliteDriver(raw),
      });
      // Insert a sentinel row.
      await m1.driver.run(
        `INSERT INTO device_id (id, device_id, created_at_utc) VALUES (1, ?, ?)`,
        ['anon-1', Date.now()],
      );

      // Re-open against the SAME raw connection: migrate must be a no-op
      // and the sentinel row must survive.
      const m2 = await StorageManager.open({
        layout: { docsDir: docs },
        driver: betterSqliteDriver(raw),
      });
      const count = (await m2.driver.get<CountRow>(
        `SELECT COUNT(*) AS n FROM device_id`,
      )) as CountRow;
      expect(count.n).toBe(1);
      await m2.close();
    } finally {
      await fs.rm(docs, { recursive: true, force: true });
    }
  });
});
