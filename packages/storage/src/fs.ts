// fs.ts — re-exports filesystem helpers bound to a FileSystemPort.
//
// Callers that already hold a StorageManager should prefer
// `manager.verifySha256()` / `manager.stageAndRename()`.

export {
  SHA256_CHUNK_BYTES,
  stageAndRename,
  verifySha256,
  sha256Hex,
  type FileSystemPort,
  type FileStat,
  type WriteFromIterableResult,
} from './fsPort';

export { createNodeFsPort } from './nodeFsPort';
