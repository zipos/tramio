// Cross-platform Ed25519 manifest signature verification (device + tests).

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

import { canonicalJsonStringify } from './downloader-core';

// React Native has no WebCrypto SHA-512; noble-ed25519 requires an explicit hash.
ed.hashes.sha512 = sha512 as typeof ed.hashes.sha512;
ed.hashes.sha512Async = ((message: Uint8Array) =>
  Promise.resolve(sha512(message))) as typeof ed.hashes.sha512Async;

function base64urlDecode(s: string): Uint8Array {
  const padLen = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Ed25519 SubjectPublicKeyInfo DER ends with the 32-byte raw public key. */
function extractEd25519PublicKey(spki: Uint8Array): Uint8Array {
  if (spki.length < 32) {
    throw new Error('invalid Ed25519 SPKI');
  }
  return spki.subarray(spki.length - 32);
}

/**
 * Verify a signed manifest / catalog envelope using a pinned catalog public key
 * (SPKI base64url). When `expectedKid` is set, reject envelopes with a different kid.
 */
export async function verifyManifestSignatureSpki(
  publicKeySpkiB64Url: string,
  signed: { readonly payload: unknown; readonly signature: string; readonly kid: string },
  expectedKid?: string,
): Promise<boolean> {
  try {
    if (expectedKid != null && signed.kid !== expectedKid) {
      return false;
    }
    const spki = base64urlDecode(publicKeySpkiB64Url);
    const publicKey = extractEd25519PublicKey(spki);
    const msg = new TextEncoder().encode(canonicalJsonStringify(signed.payload));
    const sig = base64urlDecode(signed.signature);
    return await ed.verifyAsync(sig, msg, publicKey);
  } catch {
    return false;
  }
}
