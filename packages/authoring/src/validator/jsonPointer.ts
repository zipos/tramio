// RFC 6901 JSON Pointer helpers.
//
// We encode pointers from arrays of segments. Per RFC 6901 §3:
//   - `~` is escaped as `~0`
//   - `/` is escaped as `~1`
// The empty pointer `""` refers to the whole document.

export type PointerSegment = string | number;

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Build an RFC 6901 JSON Pointer from an ordered list of segments. */
export function pointerFromSegments(segments: readonly PointerSegment[]): string {
  if (segments.length === 0) return '';
  let out = '';
  for (const seg of segments) {
    out += '/';
    out += typeof seg === 'number' ? String(seg) : escapeSegment(seg);
  }
  return out;
}

/**
 * Translate an Ajv `instancePath` (already RFC 6901-shaped) to our
 * internal pointer form. Ajv emits `""` for root errors and
 * `"/foo/0/bar"` for nested paths; that matches RFC 6901, so the
 * function is essentially identity. It exists so the validator's
 * intent is documented at the call site.
 */
export function ajvInstancePathToPointer(instancePath: string): string {
  return instancePath;
}
