/**
 * Ed25519 signing primitives for Tramio backend responses.
 *
 * The catalog and moderation endpoints sign a JSON `payload` with a key in
 * the `cat-` namespace; the entitlement endpoints sign with a key in the
 * `ent-` namespace. Public halves of these keys ship in the client so cached
 * payloads can be tamper-checked even when the device is offline.
 *
 * Signatures cover a deterministic JSON encoding of the payload (sorted
 * object keys, no whitespace) so a stored bytestring round-trips through
 * any JSON parser without changing the digest.
 */
import { sign, verify, generateKeyPairSync, createPublicKey, type KeyObject } from 'node:crypto';

/** Base64url with no padding, per RFC 7515. */
export function base64urlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Deterministic JSON serialization with sorted object keys. Strings are
 * encoded by `JSON.stringify` so escaping rules match the standard parser.
 *
 * NB: arrays preserve insertion order; only object key order is normalized.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return JSON.stringify(k) + ':' + canonicalJsonStringify(v);
  });
  return '{' + parts.join(',') + '}';
}

/** Sign the canonical JSON encoding of `payload`. Returns base64url. */
export function signPayload(privateKey: KeyObject, payload: unknown): string {
  const msg = Buffer.from(canonicalJsonStringify(payload), 'utf8');
  const sig = sign(null, msg, privateKey);
  return base64urlEncode(sig);
}

/** Verify a base64url Ed25519 signature against the canonical encoding. */
export function verifyPayload(
  publicKey: KeyObject,
  payload: unknown,
  signatureB64Url: string,
): boolean {
  const msg = Buffer.from(canonicalJsonStringify(payload), 'utf8');
  return verify(null, msg, publicKey, base64urlDecode(signatureB64Url));
}

/** Sign raw bytes (used for the detached MANIFEST.lock.sig wire format). */
export function signBytes(privateKey: KeyObject, bytes: Buffer | Uint8Array): string {
  const sig = sign(null, Buffer.from(bytes), privateKey);
  return base64urlEncode(sig);
}

export function verifyBytes(
  publicKey: KeyObject,
  bytes: Buffer | Uint8Array,
  signatureB64Url: string,
): boolean {
  return verify(null, Buffer.from(bytes), publicKey, base64urlDecode(signatureB64Url));
}

/** Generate a fresh Ed25519 keypair (used for tests + first-run keygen). */
export function generateEd25519KeyPair(): { publicKey: KeyObject; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

/** Export an Ed25519 public key as DER `spki` base64url for client-side pinning. */
export function exportPublicKeySpkiB64Url(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return base64urlEncode(der);
}

/** Import an Ed25519 public key from DER `spki` base64url. */
export function importPublicKeySpkiB64Url(b64url: string): KeyObject {
  return createPublicKey({
    key: base64urlDecode(b64url),
    format: 'der',
    type: 'spki',
  });
}
