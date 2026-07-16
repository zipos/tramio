// Expo FileSystemPort — on-device pack storage via expo-file-system.

import { File } from 'expo-file-system';
import * as LegacyFS from 'expo-file-system/legacy';

import type { FileSystemPort } from './fsPort';
import { Sha256 } from './sha256';

function toUint8(chunk: Uint8Array | ArrayBuffer): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
}

async function hashReadableStream(stream: ReadableStream<Uint8Array>): Promise<{
  bytesWritten: number;
  sha256Hex: string;
}> {
  const reader = stream.getReader();
  const hash = new Sha256();
  let bytesWritten = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(toUint8(value));
        bytesWritten += value.length;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { bytesWritten, sha256Hex: hash.finalizeHex() };
}

/**
 * Build a FileSystemPort backed by Expo's legacy + modern file APIs.
 */
export function createExpoFsPort(): FileSystemPort {
  return {
    async mkdir(dir, options) {
      await LegacyFS.makeDirectoryAsync(dir, { intermediates: options?.recursive ?? false });
    },

    async rm(target, options) {
      if (options?.force === false) {
        const info = await LegacyFS.getInfoAsync(target);
        if (!info.exists) return;
      }
      await LegacyFS.deleteAsync(target, { idempotent: options?.force ?? false });
    },

    async rename(from, to) {
      await LegacyFS.moveAsync({ from, to });
    },

    async stat(target) {
      const info = await LegacyFS.getInfoAsync(target);
      if (!info.exists) return null;
      return {
        isFile: !info.isDirectory,
        isDirectory: info.isDirectory ?? false,
      };
    },

    async readUtf8(filePath) {
      return LegacyFS.readAsStringAsync(filePath, { encoding: LegacyFS.EncodingType.UTF8 });
    },

    async sha256Hex(filePath) {
      const file = new File(filePath);
      return (await hashReadableStream(file.readableStream())).sha256Hex;
    },

    async writeFromIterable(filePath, chunks) {
      const parent = filePath.slice(0, filePath.lastIndexOf('/'));
      if (parent.length > 0) {
        await LegacyFS.makeDirectoryAsync(parent, { intermediates: true });
      }

      const file = new File(filePath);
      file.create({ overwrite: true, intermediates: true });

      const writer = file.writableStream().getWriter();
      const hash = new Sha256();
      let bytesWritten = 0;
      try {
        for await (const chunk of chunks) {
          const bytes = toUint8(chunk);
          hash.update(bytes);
          await writer.write(bytes);
          bytesWritten += bytes.length;
        }
      } finally {
        await writer.close();
      }

      return { bytesWritten, sha256Hex: hash.finalizeHex() };
    },
  };
}

/**
 * Resolve the platform documents directory for Storage_Manager layout.
 */
export function resolveExpoDocumentDirectory(): string {
  const docs = LegacyFS.documentDirectory;
  if (!docs) {
    throw new Error('expo-file-system: documentDirectory is unavailable');
  }
  return docs.replace(/\/+$/, '');
}
