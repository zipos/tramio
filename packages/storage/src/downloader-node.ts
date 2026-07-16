// Node-only manifest signature verification for unit tests.

import * as crypto from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { canonicalJsonStringify } from './downloader-core';
import type { ManifestVerifier, SignedManifest } from './downloader-types';

function base64urlDecode(s: string): Buffer {
  const padLen = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

/**
 * Verify the Ed25519 signature on a `SignedManifest` using Node crypto.
 */
export function verifyManifestSignature(publicKey: KeyObject, signed: SignedManifest): boolean {
  let ok = false;
  try {
    const canonical = canonicalJsonStringify(signed.payload);
    const sig = base64urlDecode(signed.signature);
    ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, sig);
  } catch {
    ok = false;
  }
  return ok;
}

/** Node test helper: build a verifier from a crypto KeyObject. */
export function createNodeManifestVerifier(publicKey: KeyObject): ManifestVerifier {
  return {
    verify: (signed) => verifyManifestSignature(publicKey, signed),
  };
}
