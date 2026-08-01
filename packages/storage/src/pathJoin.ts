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
  const firstNonEmpty = segments.find((segment) => segment.length > 0) ?? '';
  const schemeMatch = /^([a-z][a-z0-9+.-]*:\/\/)/iu.exec(firstNonEmpty);
  const scheme = schemeMatch?.[1] ?? '';
  let removedScheme = false;

  const parts = segments
    .filter((s) => s.length > 0)
    .map((s, i) => {
      let value = s;
      if (!removedScheme && scheme.length > 0 && value.startsWith(scheme)) {
        value = value.slice(scheme.length);
        removedScheme = true;
      }
      return i === 0 ? value.replace(/\/+$/, '') : value.replace(/^\/+|\/+$/g, '');
    })
    .filter((s) => s.length > 0);
  if (parts.length === 0) return scheme;
  return `${scheme}${parts.join('/').replace(/\/+/g, '/')}`;
}

export function pathDirname(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? '' : filePath.slice(0, idx);
}
