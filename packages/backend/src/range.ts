/**
 * Minimal HTTP byte-range parser used by the asset endpoint.
 *
 * Supports the single-range syntax we need for offline-pack downloads:
 *   - `bytes=0-`            -> start..end
 *   - `bytes=0-99`          -> first 100 bytes
 *   - `bytes=100-`          -> from byte 100 to end
 *   - `bytes=-100`          -> last 100 bytes (suffix range)
 *
 * Multipart range requests (`bytes=0-100,200-300`) are intentionally not
 * supported; we return `unsatisfiable` for those and let the caller fall
 * back to a full GET. That mirrors what plain CDNs do.
 */

export interface ResolvedRange {
  readonly kind: 'satisfiable';
  readonly start: number; // inclusive
  readonly end: number; // inclusive
}

export type ParsedRange =
  | ResolvedRange
  | { readonly kind: 'absent' }
  | { readonly kind: 'unsatisfiable' };

export function parseRange(header: string | undefined, totalSize: number): ParsedRange {
  if (header === undefined || header === '') return { kind: 'absent' };
  if (totalSize === 0) return { kind: 'unsatisfiable' };

  const m = /^\s*bytes=(\d*)-(\d*)\s*$/.exec(header);
  if (m === null) return { kind: 'unsatisfiable' };
  const startStr = m[1] ?? '';
  const endStr = m[2] ?? '';

  let start: number;
  let end: number;

  if (startStr === '' && endStr === '') {
    return { kind: 'unsatisfiable' };
  }

  if (startStr === '') {
    // suffix range: last N bytes
    const suffix = Number(endStr);
    if (!Number.isInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    if (!Number.isInteger(start) || start < 0) return { kind: 'unsatisfiable' };
    if (endStr === '') {
      end = totalSize - 1;
    } else {
      end = Number(endStr);
      if (!Number.isInteger(end) || end < start) return { kind: 'unsatisfiable' };
      // clamp end into the available range
      end = Math.min(end, totalSize - 1);
    }
  }

  if (start >= totalSize) return { kind: 'unsatisfiable' };
  return { kind: 'satisfiable', start, end };
}
