import {
  canonicalJsonStringify,
  generateEd25519KeyPair,
  signPayload,
  verifyPayload,
  exportPublicKeySpkiB64Url,
  importPublicKeySpkiB64Url,
} from './signing';

describe('canonicalJsonStringify', () => {
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
});

describe('Ed25519 sign/verify', () => {
  test('round-trips a signed payload', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const payload = { hello: 'world', n: 42 };
    const sig = signPayload(privateKey, payload);
    expect(verifyPayload(publicKey, payload, sig)).toBe(true);
    // Same payload with reordered keys still verifies (canonical JSON).
    expect(verifyPayload(publicKey, { n: 42, hello: 'world' }, sig)).toBe(true);
    // A different payload does not verify.
    expect(verifyPayload(publicKey, { hello: 'world', n: 43 }, sig)).toBe(false);
  });

  test('public key spki round-trip preserves verify capability', () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();
    const payload = { x: 1 };
    const sig = signPayload(privateKey, payload);
    const exported = exportPublicKeySpkiB64Url(publicKey);
    const reimported = importPublicKeySpkiB64Url(exported);
    expect(verifyPayload(reimported, payload, sig)).toBe(true);
  });
});
