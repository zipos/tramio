// pathJoin — POSIX path join without Node's `path` module (safe for React Native).

export class UnsafePackPathError extends Error {
  public override readonly name = 'UnsafePackPathError';
}

/**
 * Reject absolute paths and `..` / empty segments so pack assets cannot escape the
 * staging / pack root (zip-slip defense).
 */
export function assertSafePackRelativePath(relPath: string): void {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new UnsafePackPathError('pack-relative path must be a non-empty string');
  }
  if (relPath.includes('\u0000') || relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new UnsafePackPathError(`unsafe pack-relative path: ${relPath}`);
  }
  for (const segment of relPath.split(/[/\\]/u)) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new UnsafePackPathError(`unsafe pack-relative path: ${relPath}`);
    }
  }
}

export function pathJoin(...segments: string[]): string {
  const parts = segments
    .filter((s) => s.length > 0)
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '')))
    .filter((s) => s.length > 0);
  if (parts.length === 0) return '';
  return parts.join('/').replace(/\/+/g, '/');
}

export function pathDirname(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? '' : filePath.slice(0, idx);
}
