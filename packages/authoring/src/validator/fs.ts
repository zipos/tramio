// Filesystem abstraction for the Content_Bundle validator.
//
// The validator never touches `node:fs` directly. It accepts a
// `BundleFileSystem` implementation that walks a bundle root and reads
// individual files. Two implementations live in this file:
//
//   - `nodeFileSystem(rootDir)` — reads from disk, used by the CLI
//     (task 2.3) and end-to-end tests that operate on real fixtures.
//   - `virtualFileSystem(record)` — record from bundle-relative path to
//     `string | Buffer`, used by unit tests so they can drive the
//     validator without touching a temp directory.
//
// Paths exposed by both implementations are always **bundle-relative**
// using forward slashes (e.g. `narratives/poi-rynek.pl.md`). Nothing in
// the validator's interior reasons about absolute paths or platform
// separators.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Result of `readFile`: present (with bytes) or absent. */
export type ReadResult =
  | { readonly exists: true; readonly content: Buffer }
  | { readonly exists: false };

export interface BundleFileSystem {
  /** Returns true iff a file at the bundle-relative path exists. */
  exists(relativePath: string): boolean;
  /** Reads a file by bundle-relative path. Never throws on absence. */
  readFile(relativePath: string): ReadResult;
  /**
   * Lists every bundle-relative path the filesystem knows about.
   * Order is unspecified; callers should not rely on it. Used by the
   * validator to discover narratives, standby tracks, and audio assets
   * referenced from authored files.
   */
  listFiles(): readonly string[];
}

// ---------------------------------------------------------------------------
// Node filesystem (real disk)
// ---------------------------------------------------------------------------

function toBundleRelative(rootDir: string, abs: string): string {
  const rel = path.relative(rootDir, abs);
  // Always emit forward slashes regardless of host OS so authored paths
  // (which are forward-slash) compare equal to discovered paths.
  return rel.split(path.sep).join('/');
}

function listFilesRecursively(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
      } else if (ent.isFile()) {
        out.push(toBundleRelative(rootDir, abs));
      }
    }
  }
  return out;
}

/**
 * Reads from a real bundle directory on disk. The validator and the
 * `bundle-validate` CLI (task 2.3) use this. Unit tests should prefer
 * `virtualFileSystem`.
 */
export function nodeFileSystem(rootDir: string): BundleFileSystem {
  const cachedListing = listFilesRecursively(rootDir);
  return {
    exists(relativePath: string): boolean {
      const abs = path.join(rootDir, relativePath);
      try {
        const stat = fs.statSync(abs);
        return stat.isFile();
      } catch {
        return false;
      }
    },
    readFile(relativePath: string): ReadResult {
      const abs = path.join(rootDir, relativePath);
      try {
        const content = fs.readFileSync(abs);
        return { exists: true, content };
      } catch {
        return { exists: false };
      }
    },
    listFiles(): readonly string[] {
      return cachedListing;
    },
  };
}

// ---------------------------------------------------------------------------
// Virtual filesystem (in-memory)
// ---------------------------------------------------------------------------

/**
 * Map (or plain record) from bundle-relative path to file content. String
 * values are encoded as UTF-8 when the validator needs raw bytes.
 */
export type VirtualBundle = Readonly<Record<string, string | Buffer>>;

function normalizePath(p: string): string {
  // Strip leading `./` or `/` so consumers may write paths either way.
  let n = p.replace(/^\.\//, '');
  if (n.startsWith('/')) n = n.slice(1);
  return n.split('\\').join('/');
}

export function virtualFileSystem(record: VirtualBundle): BundleFileSystem {
  const normalized = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(record)) {
    const key = normalizePath(k);
    const buf = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
    normalized.set(key, buf);
  }
  const keys = Array.from(normalized.keys());
  return {
    exists(relativePath: string): boolean {
      return normalized.has(normalizePath(relativePath));
    },
    readFile(relativePath: string): ReadResult {
      const buf = normalized.get(normalizePath(relativePath));
      if (!buf) return { exists: false };
      return { exists: true, content: buf };
    },
    listFiles(): readonly string[] {
      return keys;
    },
  };
}
