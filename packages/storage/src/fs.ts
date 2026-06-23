// Atomic stage+rename and streaming SHA-256 verifier.
//
// design.md "## Offline Pack Format and Download Strategy" requires that
// each asset is streamed to a `.part` file and renamed only after its full
// SHA-256 matches the lock file (Req 3.1, 3.3, 3.5). The 64 KiB chunk size
// matches the AEAD frame size used by Crypto_Service so the verifier can
// share buffer arithmetic with the decrypt path later.
//
// All helpers here are pure wrappers over `node:fs/promises` and are safe
// to use from both production code and unit tests.

import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

/**
 * Chunk size used by the streaming verifier and the AEAD framing.
 * Keep in sync with `MANIFEST.lock.json#encryption.chunkBytes` (64 KiB).
 *
 * @see design.md "## Offline Pack Format and Download Strategy"
 */
export const SHA256_CHUNK_BYTES = 64 * 1024;

/**
 * Move `stagingPath` to `finalPath` atomically.
 *
 * Behavior:
 *  - Ensures the parent of `finalPath` exists (mkdir -p).
 *  - If `finalPath` already exists it is removed first. This matches the
 *    contract used by the downloader, which only calls `stageAndRename`
 *    after the new bytes have been verified — overwriting a stale or
 *    partial leftover is the desired outcome.
 *  - Uses `fs.rename`, which is atomic on the same filesystem volume on
 *    POSIX and Windows. If the rename fails with `EXDEV` (cross-device),
 *    we surface the error rather than silently falling back to a
 *    non-atomic copy: callers should stage on the same volume as the
 *    final path.
 *
 * @see Requirements 3.1, 3.5
 */
export async function stageAndRename(stagingPath: string, finalPath: string): Promise<void> {
  if (typeof stagingPath !== 'string' || stagingPath.length === 0) {
    throw new TypeError('stagingPath must be a non-empty string');
  }
  if (typeof finalPath !== 'string' || finalPath.length === 0) {
    throw new TypeError('finalPath must be a non-empty string');
  }

  await fs.mkdir(path.dirname(finalPath), { recursive: true });

  // Best-effort cleanup of any prior contents at finalPath. `force: true`
  // makes it a no-op when finalPath does not exist; `recursive: true`
  // covers the directory-rename case used to promote `{version}.staging`
  // to `{version}`.
  try {
    await fs.rm(finalPath, { recursive: true, force: true });
  } catch {
    // fs.rm with `force: true` does not throw on missing targets; any
    // failure here is a real I/O problem and will surface from rename.
  }

  await fs.rename(stagingPath, finalPath);
}

/**
 * Compute the SHA-256 of `filePath` by streaming the file in
 * `SHA256_CHUNK_BYTES`-sized chunks, and compare to `expectedHex`.
 *
 * Returns `true` iff the file exists and its SHA-256 lower-hex digest
 * matches `expectedHex` (case-insensitive). Returns `false` on any
 * mismatch. Throws on I/O errors other than ENOENT — a missing file
 * is treated as "not verified" rather than a programmer error so the
 * downloader's resume path can call this freely.
 *
 * @see design.md "## Offline Pack Format and Download Strategy" point 3
 * @see Requirements 3.1, 3.3, 3.5
 */
export async function verifySha256(filePath: string, expectedHex: string): Promise<boolean> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('filePath must be a non-empty string');
  }
  if (typeof expectedHex !== 'string' || expectedHex.length === 0) {
    return false;
  }
  // SHA-256 is 32 bytes -> 64 hex chars.
  if (!/^[0-9a-fA-F]{64}$/.test(expectedHex)) {
    return false;
  }

  let exists = true;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return false;
    }
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      exists = false;
    } else {
      throw err;
    }
  }
  if (!exists) {
    return false;
  }

  const actualHex = await sha256Hex(filePath);
  return timingSafeEqualHex(actualHex, expectedHex.toLowerCase());
}

/**
 * Streaming SHA-256 hex digest of `filePath`. Exposed for callers that
 * already have the expected digest in another shape (e.g., the downloader
 * recording `sha256` into `pack_progress`).
 */
export async function sha256Hex(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: SHA256_CHUNK_BYTES });
    stream.on('data', (chunk: Buffer | string) => {
      // createReadStream without an encoding yields Buffer chunks. We pass
      // them straight through to the hash without any intermediate copy.
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(ab, bb);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
