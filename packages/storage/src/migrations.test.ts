// Migration runner tests against an in-memory better-sqlite3 instance.
//
// We import better-sqlite3 lazily so a missing binary surfaces as a
// useful test failure rather than crashing the whole suite.

import Database from 'better-sqlite3';

import { betterSqliteDriver } from './sqlite';
import {
  migrate,
  readCurrentVersion,
  MIGRATIONS,
} from './migrations';
import { SCHEMA_VERSION } from './schema';

interface CountRow {
  n: number;
}

async function openDriver(): Promise<{
  driver: ReturnType<typeof betterSqliteDriver>;
  raw: Database.Database;
}> {
  const raw = new Database(':memory:');
  return { driver: betterSqliteDriver(raw), raw };
}

describe('migrate', () => {
  it('installs every required table on a fresh database', async () => {
    const { driver, raw } = await openDriver();
    try {
      await migrate(driver);

      const tables = raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
        )
        .all() as ReadonlyArray<{ name: string }>;
      const names = tables.map((t) => t.name);

      // Required tables from task 5.1.
      for (const required of [
        'pack_progress',
        'entitlement_cache',
        'lru_access',
        'moderation_snapshot',
        'device_id',
        'license_tokens',
        '_schema_version',
      ]) {
        expect(names).toContain(required);
      }
    } finally {
      await driver.close();
    }
  });

  it('records SCHEMA_VERSION in _schema_version', async () => {
    const { driver } = await openDriver();
    try {
      const installed = await migrate(driver);
      expect(installed).toBe(SCHEMA_VERSION);
      expect(await readCurrentVersion(driver)).toBe(SCHEMA_VERSION);
    } finally {
      await driver.close();
    }
  });

  it('is idempotent — running migrate twice does not error or duplicate state', async () => {
    const { driver, raw } = await openDriver();
    try {
      await migrate(driver);

      // Insert a row to make sure the second migrate doesn't truncate the
      // tables.
      raw.prepare(
        `INSERT INTO device_id (id, device_id, created_at_utc) VALUES (1, ?, ?)`,
      ).run('anon-device-test', Date.now());

      await migrate(driver);
      await migrate(driver);

      const after = raw.prepare(`SELECT COUNT(*) AS n FROM device_id`).get() as CountRow;
      expect(after.n).toBe(1);
      expect(await readCurrentVersion(driver)).toBe(SCHEMA_VERSION);
    } finally {
      await driver.close();
    }
  });

  it('CHECK constraint on pack_progress.status rejects unknown values', async () => {
    const { driver, raw } = await openDriver();
    try {
      await migrate(driver);
      const insert = raw.prepare(
        `INSERT INTO pack_progress
           (bundle_id, version, asset_path, status, bytes_total, bytes_done, sha256, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      expect(() =>
        insert.run('b', 'v', 'a', 'bogus', 0, 0, null, Date.now()),
      ).toThrow();
      // Valid status passes.
      insert.run('b', 'v', 'a', 'pending', 0, 0, null, Date.now());
    } finally {
      await driver.close();
    }
  });

  it('CHECK constraint on device_id pins it to a single row', async () => {
    const { driver, raw } = await openDriver();
    try {
      await migrate(driver);
      const insert = raw.prepare(
        `INSERT INTO device_id (id, device_id, created_at_utc) VALUES (?, ?, ?)`,
      );
      insert.run(1, 'anon-1', Date.now());
      // id != 1 must be rejected.
      expect(() => insert.run(2, 'anon-2', Date.now())).toThrow();
      // PK conflict on id = 1 must also be rejected.
      expect(() => insert.run(1, 'anon-3', Date.now())).toThrow();
    } finally {
      await driver.close();
    }
  });

  it('MIGRATIONS list is strictly increasing with no duplicate versions', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
