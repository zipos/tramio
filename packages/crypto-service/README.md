# @tramio/crypto-service

Crypto_Service. Owns:

- Hardware-backed `hardware_secret` provisioning (Keychain on iOS, AndroidKeystore on Android, Secure Enclave / StrongBox when available).
- `Wrapping_Key` derivation via HKDF-SHA256, with the versioned info string assembled at runtime as defense-in-depth.
- AES-256-GCM framing (64 KiB chunks, per-chunk nonce + tag, sequence numbers in AAD).
- License_Token (JWS / Ed25519) verification against a pinned public-key set with `kid` rotation.
- Streaming decrypt API (`openDecryptedStream`) and small in-memory decrypt
  (`decryptInMemory`) for narrative Markdown.

JS callers receive opaque `KeyHandle`s, never raw key material.

Module boundary set up in task 1.3.
