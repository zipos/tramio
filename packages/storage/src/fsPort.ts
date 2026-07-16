// FileSystemPort — platform-neutral filesystem surface for Storage_Manager.
//
// Node tests use `createNodeFsPort()`; the React Native app uses
// `createExpoFsPort()` backed by `expo-file-system`.

import { pathDirname } from './pathJoin';

import { Sha256, sha256HexFromIterable } from './sha256';

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface WriteFromIterableResult {
  bytesWritten: number;
  sha256Hex: string;
}

/**
 * Minimal filesystem contract used by StorageManager, the downloader,
 * LRU eviction, and pack loading. Implementations must support atomic
 * rename on the same volume (stage+rename promotion).
 */
export interface FileSystemPort {
  mkdir(dir: string, options?: { recursive?: boolean }): Promise<void>;
  rm(target: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Returns `null` when the path does not exist. */
  stat(target: string): Promise<FileStat | null>;
  readUtf8(filePath: string): Promise<string>;
  sha256Hex(filePath: string): Promise<string>;
  writeFromIterable(
    filePath: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<WriteFromIterableResult>;
}

export const SHA256_CHUNK_BYTES = 64 * 1024;

export async function stageAndRename(
  fs: FileSystemPort,
  stagingPath: string,
  finalPath: string,
): Promise<void> {
  if (typeof stagingPath !== 'string' || stagingPath.length === 0) {
    throw new TypeError('stagingPath must be a non-empty string');
  }
  if (typeof finalPath !== 'string' || finalPath.length === 0) {
    throw new TypeError('finalPath must be a non-empty string');
  }

  await fs.mkdir(pathDirname(finalPath), { recursive: true });
  try {
    await fs.rm(finalPath, { recursive: true, force: true });
  } catch {
    // force:true implementations treat missing targets as no-op.
  }
  await fs.rename(stagingPath, finalPath);
}

export async function verifySha256(
  fs: FileSystemPort,
  filePath: string,
  expectedHex: string,
): Promise<boolean> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('filePath must be a non-empty string');
  }
  if (typeof expectedHex !== 'string' || expectedHex.length === 0) {
    return false;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(expectedHex)) {
    return false;
  }

  const st = await fs.stat(filePath);
  if (st === null || !st.isFile) {
    return false;
  }

  const actualHex = await fs.sha256Hex(filePath);
  return timingSafeEqualHex(actualHex, expectedHex.toLowerCase());
}

export async function sha256Hex(fs: FileSystemPort, filePath: string): Promise<string> {
  return fs.sha256Hex(filePath);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Hash a readable byte stream without persisting (used by node write path). */
export async function digestIterable(
  chunks: AsyncIterable<Uint8Array>,
): Promise<WriteFromIterableResult> {
  return sha256HexFromIterable(chunks);
}

/** Re-export for consumers that hash in memory. */
export { Sha256 };
