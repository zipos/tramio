// Migration runner.
//
// The runner is intentionally simple: a `_schema_version` metadata table
// records the highest version that has been applied; each migration is a
// `{ version, sql }` pair applied inside a transaction; running migrate()
// twice is a no-op. The downloader and the rest of Storage_Manager call
// `migrate(driver)` once during construction.

import type { SqliteDriver } from './sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema';

const META_DDL = `
CREATE TABLE IF NOT EXISTS _schema_version (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
`;

interface SchemaVersionRow {
  version: number;
}

interface Migration {
  /** Numeric schema version this migration installs. Strictly increasing. */
  readonly version: number;
  /** SQL applied inside a transaction to bring the DB up to `version`. */
  readonly sql: string;
}

/**
 * Ordered list of migrations. Append-only: never edit a previous entry.
 * Future schema changes add new `{ version: N, sql: '...' }` rows here.
 */
export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: SCHEMA_SQL }];

/**
 * Apply any pending migrations against `driver`. Idempotent: calling
 * `migrate` twice on the same database is a no-op the second time.
 *
 * Returns the schema version that is installed after the call.
 */
export async function migrate(driver: SqliteDriver): Promise<number> {
  await driver.exec(META_DDL);

  const current = await readCurrentVersion(driver);
  let installed = current;

  for (const migration of MIGRATIONS) {
    if (migration.version <= installed) {
      continue;
    }
    await driver.transaction(async () => {
      await driver.exec(migration.sql);
      await writeCurrentVersion(driver, migration.version);
    });
    installed = migration.version;
  }

  // Sanity: SCHEMA_VERSION must match the highest declared migration.
  // This guards against a stale constant after appending a migration.
  const highest = MIGRATIONS.reduce((acc, m) => Math.max(acc, m.version), 0);
  if (highest !== SCHEMA_VERSION) {
    throw new Error(
      `migrations.ts: SCHEMA_VERSION (${SCHEMA_VERSION}) does not match highest migration (${highest})`,
    );
  }

  return installed;
}

/**
 * Return the schema version currently recorded in `_schema_version`, or
 * `0` if the row has not been written yet. Exposed for diagnostics and
 * tests.
 */
export async function readCurrentVersion(driver: SqliteDriver): Promise<number> {
  const row = await driver.get<SchemaVersionRow>(
    'SELECT version FROM _schema_version WHERE id = 1',
  );
  return row?.version ?? 0;
}

async function writeCurrentVersion(driver: SqliteDriver, version: number): Promise<void> {
  await driver.run(
    `INSERT INTO _schema_version (id, version) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET version = excluded.version`,
    [version],
  );
}
