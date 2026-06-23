// SQLite driver abstraction.
//
// The runtime environment for Storage_Manager differs by host:
//
//   - On-device (React Native): a turbo module wraps `expo-sqlite` or a
//     similar binding; calls are async.
//   - In Node tests (this package's Jest suite): we use `better-sqlite3`,
//     which is synchronous.
//   - In a pinch (no native deps available), an in-memory shim that
//     implements just enough of the surface for migrations and basic
//     CRUD is provided as a fallback.
//
// To keep the rest of the package portable, every consumer talks to the
// `SqliteDriver` interface defined here. The interface is intentionally
// minimal — just enough to run schema migrations and parameterized
// CRUD against the tables defined in `schema.ts`. Production wiring can
// land later without reshaping the manager.
//
// All driver methods are typed `Promise<...>` even when the underlying
// binding is synchronous. The async surface is the lowest common
// denominator and makes RN integration straightforward.

/**
 * A single row produced by a SELECT query. Cells are SQLite-typed:
 *  - `null` for `NULL`,
 *  - `number` for `INTEGER` / `REAL`,
 *  - `string` for `TEXT`,
 *  - `Uint8Array` for `BLOB`.
 *
 * We deliberately avoid Node's `Buffer` so the type also fits an RN
 * runtime where `Buffer` is not always polyfilled.
 */
export type SqliteValue = null | number | string | Uint8Array;
/**
 * Default row shape produced by SELECT. Implementations may surface
 * BLOB columns as `Buffer` (a `Uint8Array` subclass), so we type cells
 * as `unknown`. Consumer types may declare narrower row interfaces and
 * pass them as the `R` type parameter on `all`/`get`.
 */
export type SqliteRow = Record<string, unknown>;
export type SqliteParams = readonly SqliteValue[];

export interface SqliteDriver {
  /**
   * Execute one or more statements that return no rows (DDL, INSERT,
   * UPDATE, DELETE without RETURNING). Multiple statements separated by
   * `;` MUST be supported so migrations can ship as one SQL blob.
   */
  exec(sql: string): Promise<void>;

  /** Execute a single parameterized statement and discard any rows. */
  run(sql: string, params?: SqliteParams): Promise<void>;

  /** Execute a single parameterized SELECT and return all rows. */
  all<R = SqliteRow>(sql: string, params?: SqliteParams): Promise<R[]>;

  /**
   * Execute a single parameterized SELECT and return the first row, or
   * `null` if there are no rows.
   */
  get<R = SqliteRow>(sql: string, params?: SqliteParams): Promise<R | null>;

  /**
   * Run `fn` inside a SQLite transaction. Implementations MUST roll back
   * on a thrown error and commit on success. The transactional unit is
   * a single `IMMEDIATE` write transaction — sufficient for migrations
   * and atomic multi-row state updates.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  /** Release the underlying handle. Idempotent. */
  close(): Promise<void>;
}

/**
 * Adapter from a `better-sqlite3` instance to the async `SqliteDriver`.
 *
 * `better-sqlite3` is synchronous; the adapter wraps each call in
 * `Promise.resolve(...)` so the same surface works under tests (Node)
 * and production wiring (RN turbo module, async).
 *
 * The argument is typed `unknown` to avoid forcing every consumer of
 * this package to depend on `@types/better-sqlite3`. The shape we
 * actually use is asserted at construction time.
 */
interface BetterSqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown[];
    get(...params: readonly unknown[]): unknown;
  };
  close(): unknown;
}

function isBetterSqliteLike(value: unknown): value is BetterSqliteLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { exec?: unknown }).exec === 'function' &&
    typeof (value as { prepare?: unknown }).prepare === 'function' &&
    typeof (value as { close?: unknown }).close === 'function'
  );
}

export function betterSqliteDriver(db: unknown): SqliteDriver {
  if (!isBetterSqliteLike(db)) {
    throw new TypeError('betterSqliteDriver: argument is not a better-sqlite3 instance');
  }
  const handle = db;
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error('SqliteDriver: handle is closed');
    }
  };

  const coerceParams = (params: SqliteParams | undefined): readonly unknown[] => {
    if (params === undefined) {
      return [];
    }
    // better-sqlite3 accepts Buffer but not Uint8Array directly in all
    // versions; convert when we see a typed array.
    return params.map((p) =>
      p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p) : p,
    );
  };

  return {
    exec(sql) {
      ensureOpen();
      handle.exec(sql);
      return Promise.resolve();
    },
    run(sql, params) {
      ensureOpen();
      handle.prepare(sql).run(...coerceParams(params));
      return Promise.resolve();
    },
    all<R = SqliteRow>(sql: string, params?: SqliteParams): Promise<R[]> {
      ensureOpen();
      const rows = handle.prepare(sql).all(...coerceParams(params));
      return Promise.resolve(rows as R[]);
    },
    get<R = SqliteRow>(
      sql: string,
      params?: SqliteParams,
    ): Promise<R | null> {
      ensureOpen();
      const row = handle.prepare(sql).get(...coerceParams(params));
      return Promise.resolve((row ?? null) as R | null);
    },
    async transaction<T>(fn: () => Promise<T>): Promise<T> {
      ensureOpen();
      handle.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        handle.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          handle.exec('ROLLBACK');
        } catch {
          // Ignore rollback failures; surface the original error.
        }
        throw err;
      }
    },
    close() {
      if (!closed) {
        closed = true;
        handle.close();
      }
      return Promise.resolve();
    },
  };
}
