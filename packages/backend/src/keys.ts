/**
 * Signing-key registry.
 *
 * The MVP uses two long-lived Ed25519 keys:
 *   - `cat-001`  signs `/v1/catalog/*`, `/v1/gtfs/*`, `/v1/moderation`
 *                payloads and the detached `MANIFEST.lock.sig` for packs.
 *   - `ent-001`  signs `/v1/entitlements*` payloads.
 *
 * `kid` namespaces (`cat-` vs `ent-`) match design.md so future rotation
 * keeps the two key classes independent. Public halves are exported via
 * `getPublicKeySet()` so the client (and tests) can pin them.
 */
import type { KeyObject } from 'node:crypto';
import { exportPublicKeySpkiB64Url, generateEd25519KeyPair } from './signing';

/** Discriminates which signing key class to use. */
export type KeyClass = 'cat' | 'ent';

/** A key entry in the registry. `privateKey` is server-side only. */
export interface KeyEntry {
  readonly kid: string;
  readonly keyClass: KeyClass;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

/**
 * Public-key descriptor shipped to the client. `publicKeySpkiB64Url` is the
 * Ed25519 public key in DER `SubjectPublicKeyInfo` form, base64url-encoded
 * (RFC 7515 style). Clients import it via `crypto.subtle.importKey('spki',
 * ...)` or `node:crypto.createPublicKey({ format: 'der', type: 'spki' })`.
 */
export interface PublicKeyDescriptor {
  readonly kid: string;
  readonly keyClass: KeyClass;
  readonly publicKeySpkiB64Url: string;
}

export interface KeyRegistry {
  /** Resolve the active signing key for a class (e.g. `cat-001`). */
  getActive(keyClass: KeyClass): KeyEntry;
  /** Look up a key by kid; returns undefined if unknown. */
  getByKid(kid: string): KeyEntry | undefined;
  /** All public keys, for client-side pinning + tests. */
  getPublicKeySet(): ReadonlyArray<PublicKeyDescriptor>;
}

/** Default kid for each class in the MVP. */
export const DEFAULT_CATALOG_KID = 'cat-001';
export const DEFAULT_ENTITLEMENT_KID = 'ent-001';

/** Build an in-memory key registry. Generates fresh keys when none provided. */
export function createKeyRegistry(seed?: {
  catalog?: KeyEntry;
  entitlement?: KeyEntry;
}): KeyRegistry {
  const cat = seed?.catalog ?? makeKeyEntry(DEFAULT_CATALOG_KID, 'cat');
  const ent = seed?.entitlement ?? makeKeyEntry(DEFAULT_ENTITLEMENT_KID, 'ent');
  const byKid = new Map<string, KeyEntry>([
    [cat.kid, cat],
    [ent.kid, ent],
  ]);
  return {
    getActive(keyClass: KeyClass): KeyEntry {
      return keyClass === 'cat' ? cat : ent;
    },
    getByKid(kid: string): KeyEntry | undefined {
      return byKid.get(kid);
    },
    getPublicKeySet(): ReadonlyArray<PublicKeyDescriptor> {
      return [cat, ent].map((e) => ({
        kid: e.kid,
        keyClass: e.keyClass,
        publicKeySpkiB64Url: exportPublicKeySpkiB64Url(e.publicKey),
      }));
    },
  };
}

function makeKeyEntry(kid: string, keyClass: KeyClass): KeyEntry {
  const { publicKey, privateKey } = generateEd25519KeyPair();
  return { kid, keyClass, publicKey, privateKey };
}
