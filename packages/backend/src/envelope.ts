/**
 * Signed JSON envelope used by every JSON-returning endpoint.
 *
 * Wire shape: `{ payload: <T>, signature: <base64url>, kid: <string> }`.
 *
 * `signature` is an Ed25519 signature over the canonical JSON encoding of
 * `payload`. The client recomputes the canonical encoding (sorted object
 * keys) before verifying, so payload byte order on the wire does not affect
 * the digest.
 */
import type { KeyEntry } from './keys';
import { signPayload } from './signing';

export interface SignedEnvelope<T> {
  readonly payload: T;
  readonly signature: string;
  readonly kid: string;
}

/** Wrap `payload` into a signed envelope using the given key entry. */
export function signEnvelope<T>(key: KeyEntry, payload: T): SignedEnvelope<T> {
  return {
    payload,
    signature: signPayload(key.privateKey, payload),
    kid: key.kid,
  };
}
