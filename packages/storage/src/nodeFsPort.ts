// Node.js FileSystemPort — used by Jest tests and backend tooling.

import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { FileSystemPort } from './fsPort';
import { SHA256_CHUNK_BYTES } from './fsPort';
import { Sha256 } from './sha256';

function toBuffer(chunk: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export function createNodeFsPort(): FileSystemPort {
  return {
    async mkdir(dir, options) {
      await fs.mkdir(dir, { recursive: options?.recursive ?? false });
    },

    async rm(target, options) {
      await fs.rm(target, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
    },

    async rename(from, to) {
      await fs.rename(from, to);
    },

    async stat(target) {
      try {
        const st = await fs.stat(target);
        return { isFile: st.isFile(), isDirectory: st.isDirectory() };
      } catch (err: unknown) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },

    async readUtf8(filePath) {
      return fs.readFile(filePath, 'utf8');
    },

    async sha256Hex(filePath) {
      const hash = new Sha256();
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath, { highWaterMark: SHA256_CHUNK_BYTES });
        stream.on('data', (chunk: Buffer | string) => {
          hash.update(toBuffer(chunk as Buffer));
        });
        stream.on('error', reject);
        stream.on('end', resolve);
      });
      return hash.finalizeHex();
    },

    async writeFromIterable(filePath, chunks) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const hash = new Sha256();
      let bytesWritten = 0;
      const handle = await fs.open(filePath, 'w');
      try {
        for await (const chunk of chunks) {
          const buf = toBuffer(chunk);
          hash.update(buf);
          await handle.write(buf);
          bytesWritten += buf.length;
        }
      } finally {
        await handle.close();
      }
      return { bytesWritten, sha256Hex: hash.finalizeHex() };
    },
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
