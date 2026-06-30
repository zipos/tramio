// expo-sqlite adapter for Storage_Manager's SqliteDriver interface.
//
// Used on-device via Expo's autolinked SQLite module. Node/Jest tests
// continue to use better-sqlite3 through betterSqliteDriver().

import type { SQLiteDatabase } from 'expo-sqlite';

import type { SqliteDriver, SqliteParams, SqliteRow, SqliteValue } from './sqlite';

function bindParams(params: SqliteParams | undefined): SqliteValue[] {
  return params === undefined ? [] : [...params];
}

/**
 * Wrap an opened `expo-sqlite` database handle as a `SqliteDriver`.
 */
export function expoSqliteDriver(db: SQLiteDatabase): SqliteDriver {
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error('SqliteDriver: handle is closed');
    }
  };

  return {
    exec(sql) {
      ensureOpen();
      return db.execAsync(sql);
    },
    run(sql, params) {
      ensureOpen();
      const bound = bindParams(params);
      return (bound.length === 0 ? db.runAsync(sql) : db.runAsync(sql, ...bound)).then(
        () => undefined,
      );
    },
    all<R = SqliteRow>(sql: string, params?: SqliteParams): Promise<R[]> {
      ensureOpen();
      const bound = bindParams(params);
      return bound.length === 0 ? db.getAllAsync<R>(sql) : db.getAllAsync<R>(sql, ...bound);
    },
    get<R = SqliteRow>(sql: string, params?: SqliteParams): Promise<R | null> {
      ensureOpen();
      const bound = bindParams(params);
      return bound.length === 0 ? db.getFirstAsync<R>(sql) : db.getFirstAsync<R>(sql, ...bound);
    },
    transaction<T>(fn: () => Promise<T>): Promise<T> {
      ensureOpen();
      let result!: T;
      return db
        .withTransactionAsync(async () => {
          result = await fn();
        })
        .then(() => result);
    },
    close() {
      if (!closed) {
        closed = true;
        return db.closeAsync();
      }
      return Promise.resolve();
    },
  };
}

/**
 * Open the default app database and return a ready `SqliteDriver`.
 */
export async function openExpoSqliteDriver(databaseName = 'tramio.db'): Promise<SqliteDriver> {
  const { openDatabaseAsync } = await import('expo-sqlite');
  const db = await openDatabaseAsync(databaseName);
  return expoSqliteDriver(db);
}
