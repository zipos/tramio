// Atomic rename and streaming SHA-256 — tests against a real tmp dir.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256Hex, stageAndRename, verifySha256, SHA256_CHUNK_BYTES } from './fs';

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tramio-storage-fs-'));
}

async function rmTmp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

describe('stageAndRename', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkTmp();
  });

  afterEach(async () => {
    await rmTmp(tmp);
  });

  it('moves a staged file into place and never leaves a partial at the final path', async () => {
    const staging = path.join(tmp, 'asset.part');
    const finalPath = path.join(tmp, 'sub', 'asset.bin');
    const payload = Buffer.from('hello tramio');
    await fs.writeFile(staging, payload);

    // Final path must NOT exist before the rename.
    await expect(fs.access(finalPath)).rejects.toThrow();

    await stageAndRename(staging, finalPath);

    // Staging is gone, final has the exact bytes.
    await expect(fs.access(staging)).rejects.toThrow();
    expect(await fs.readFile(finalPath)).toEqual(payload);
  });

  it('creates the parent directory of the final path on demand', async () => {
    const staging = path.join(tmp, 'asset.part');
    const finalPath = path.join(tmp, 'a', 'b', 'c', 'asset.bin');
    await fs.writeFile(staging, Buffer.from('x'));
    await stageAndRename(staging, finalPath);
    expect((await fs.stat(finalPath)).isFile()).toBe(true);
  });

  it('overwrites a stale file at the final path', async () => {
    const staging = path.join(tmp, 'asset.part');
    const finalPath = path.join(tmp, 'asset.bin');
    await fs.writeFile(finalPath, Buffer.from('stale'));
    await fs.writeFile(staging, Buffer.from('fresh'));

    await stageAndRename(staging, finalPath);
    expect(await fs.readFile(finalPath, 'utf8')).toBe('fresh');
  });

  it('promotes a staging directory to the final version directory atomically', async () => {
    const stagingDir = path.join(tmp, '1.4.2.staging');
    const finalDir = path.join(tmp, '1.4.2');
    await fs.mkdir(path.join(stagingDir, 'narratives'), { recursive: true });
    await fs.writeFile(path.join(stagingDir, 'manifest.json'), '{}');
    await fs.writeFile(path.join(stagingDir, 'narratives', 'a.md'), 'hi');

    await stageAndRename(stagingDir, finalDir);

    // Staging is gone; final has the same tree.
    await expect(fs.access(stagingDir)).rejects.toThrow();
    expect(await fs.readFile(path.join(finalDir, 'manifest.json'), 'utf8')).toBe('{}');
    expect(await fs.readFile(path.join(finalDir, 'narratives', 'a.md'), 'utf8')).toBe('hi');
  });

  it('rejects empty paths', async () => {
    await expect(stageAndRename('', '/tmp/x')).rejects.toThrow();
    await expect(stageAndRename('/tmp/x', '')).rejects.toThrow();
  });
});

describe('verifySha256', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkTmp();
  });

  afterEach(async () => {
    await rmTmp(tmp);
  });

  it('streams the file in chunks and accepts a matching digest', async () => {
    // 256 KiB of pseudo-random data — exercises multiple 64 KiB chunks.
    const data = crypto.randomBytes(SHA256_CHUNK_BYTES * 4 + 17);
    const file = path.join(tmp, 'asset.bin');
    await fs.writeFile(file, data);

    const expected = crypto.createHash('sha256').update(data).digest('hex');
    expect(await verifySha256(file, expected)).toBe(true);
    // Case-insensitive accept.
    expect(await verifySha256(file, expected.toUpperCase())).toBe(true);
    expect(await sha256Hex(file)).toBe(expected);
  });

  it('rejects a mismatched digest', async () => {
    const file = path.join(tmp, 'asset.bin');
    await fs.writeFile(file, Buffer.from('payload'));
    const wrong = '0'.repeat(64);
    expect(await verifySha256(file, wrong)).toBe(false);
  });

  it('returns false for a missing file rather than throwing', async () => {
    const missing = path.join(tmp, 'missing.bin');
    expect(await verifySha256(missing, 'a'.repeat(64))).toBe(false);
  });

  it('returns false for a non-hex or wrong-length expected digest', async () => {
    const file = path.join(tmp, 'asset.bin');
    await fs.writeFile(file, Buffer.from('payload'));
    expect(await verifySha256(file, 'not-hex')).toBe(false);
    expect(await verifySha256(file, '')).toBe(false);
    expect(await verifySha256(file, 'abc')).toBe(false);
  });

  it('handles an empty file deterministically', async () => {
    const file = path.join(tmp, 'empty.bin');
    await fs.writeFile(file, Buffer.alloc(0));
    const expected = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    expect(await sha256Hex(file)).toBe(expected);
    expect(await verifySha256(file, expected)).toBe(true);
  });
});
