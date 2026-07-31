// Tests for canonicalJsonStringify in downloader-core.ts (client-side).
//
// FIX 3: verifies undefined-valued keys are skipped, matching JSON.stringify
// semantics and staying in sync with the server-side implementation in
// packages/backend/src/signing.ts.

import { canonicalJsonStringify } from './downloader-core';

describe('canonicalJsonStringify (downloader-core)', () => {
  test('sorts object keys recursively', () => {
    const a = canonicalJsonStringify({ b: 1, a: 2 });
    const b = canonicalJsonStringify({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  test('preserves array order', () => {
    expect(canonicalJsonStringify([3, 2, 1])).toBe('[3,2,1]');
  });

  test('handles nested objects', () => {
    const v = canonicalJsonStringify({ z: { y: 1, x: 2 }, a: [1, 2] });
    expect(v).toBe('{"a":[1,2],"z":{"x":2,"y":1}}');
  });

  test('skips undefined-valued keys (matches JSON.stringify semantics)', () => {
    // FIX 3: undefined-valued keys must be omitted, matching JSON.stringify.
    // This implementation is kept in sync with
    // packages/backend/src/signing.ts canonicalJsonStringify.
    const payload = { a: 1, b: undefined, c: 'hello' };
    const result = canonicalJsonStringify(payload);
    expect(result).toBe('{"a":1,"c":"hello"}');
    // Verify it matches JSON.parse(JSON.stringify(...)) round-trip:
    expect(result).toBe(canonicalJsonStringify(JSON.parse(JSON.stringify(payload))));
  });

  test('skips undefined in nested objects', () => {
    const payload = { outer: { keep: true, drop: undefined }, top: 'yes' };
    const result = canonicalJsonStringify(payload);
    expect(result).toBe('{"outer":{"keep":true},"top":"yes"}');
  });

  test('produces identical output to JSON.stringify for payloads with optional fields', () => {
    // Simulates a manifest with an optional field that is undefined.
    const manifest = {
      bundleId: 'demo',
      version: '1.0.0',
      encryption: undefined,
      assets: [{ path: 'route.json', sizeBytes: 128, sha256: 'abc', protected: undefined }],
    };
    // canonicalJsonStringify should produce the same as re-parsing through JSON
    const normalized = JSON.parse(JSON.stringify(manifest));
    expect(canonicalJsonStringify(manifest)).toBe(canonicalJsonStringify(normalized));
  });
});
