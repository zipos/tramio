// StorageManager facade.
//
// Aggregates the filesystem layout helpers, the streaming SHA-256 verifier
// and the SQLite driver behind a single object so consumers (the
// downloader, the entitlement client, the engine command translators)
// have one dependency to inject.
//
// The on-device wiring constructs `StorageManager` once at app start
// with `docsDir = FileSystem.documentDirectory` and a turbo-module
// SQLite driver. Tests construct it with `os.tmpdir()` and an
// in-memory better-sqlite3 driver. Both paths exercise identical
// code below this line.

import { packDir, packsRoot, stagingDir, type PackRef, type PathLayout } from './paths';
import { stageAndRename, verifySha256, sha256Hex, type FileSystemPort } from './fsPort';
import type { SqliteDriver } from './sqlite';
import { migrate, readCurrentVersion } from './migrations';

export interface StorageManagerOptions {
  layout: PathLayout;
  driver: SqliteDriver;
  fs: FileSystemPort;
}

/**
 * Top-level Storage_Manager surface used by the rest of the app.
 *
 * Methods that touch disk and SQLite are kept narrow on purpose: the
 * downloader, LRU evictor, license cache, etc. are layered on top in
 * tasks 5.2–5.5 by composing this object rather than by extending it.
 */
export class StorageManager {
  public readonly layout: PathLayout;
  public readonly driver: SqliteDriver;
  public readonly fs: FileSystemPort;

  private constructor(opts: StorageManagerOptions) {
    this.layout = opts.layout;
    this.driver = opts.driver;
    this.fs = opts.fs;
  }

  /**
   * Construct a StorageManager and run pending migrations. Always use
   * this factory rather than calling the constructor directly so the
   * SQLite schema is guaranteed to be at the expected version before
   * any caller touches the tables.
   */
  static async open(opts: StorageManagerOptions): Promise<StorageManager> {
    const manager = new StorageManager(opts);
    await opts.fs.mkdir(packsRoot(opts.layout), { recursive: true });
    await migrate(opts.driver);
    return manager;
  }

  /** Schema version currently installed in SQLite. Useful in diagnostics. */
  schemaVersion(): Promise<number> {
    return readCurrentVersion(this.driver);
  }

  // -------- Filesystem layout --------

  /** Final pack directory: `${docs}/packs/{bundleId}/{version}/`. */
  packDir(ref: PackRef): string {
    return packDir(this.layout, ref);
  }

  /** Staging directory: `${docs}/packs/{bundleId}/{version}.staging/`. */
  stagingDir(ref: PackRef): string {
    return stagingDir(this.layout, ref);
  }

  // -------- Atomic primitives --------

  /** Atomic stage+rename. See `./fs.ts` for the contract. */
  stageAndRename(stagingPath: string, finalPath: string): Promise<void> {
    return stageAndRename(this.fs, stagingPath, finalPath);
  }

  /** Streaming SHA-256 verifier. See `./fs.ts` for the contract. */
  verifySha256(filePath: string, expectedHex: string): Promise<boolean> {
    return verifySha256(this.fs, filePath, expectedHex);
  }

  /** Streaming SHA-256 hex digest of `filePath`. */
  sha256Hex(filePath: string): Promise<string> {
    return sha256Hex(this.fs, filePath);
  }

  /** Byte size of a file, or null if absent. */
  fileSize(filePath: string): Promise<number | null> {
    return this.fs.fileSize(filePath);
  }

  /** Release the SQLite handle. Filesystem state is persistent. */
  close(): Promise<void> {
    return this.driver.close();
  }
}
