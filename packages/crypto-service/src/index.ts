// @tramio/crypto-service
//
// Crypto_Service: hardware-backed `hardware_secret` provisioning,
// `Wrapping_Key = HKDF-SHA256(...)` derivation, License_Token (JWS / Ed25519)
// verification, and framed AES-256-GCM streaming decrypt for protected
// Content_Bundle assets. The TypeScript front-end orchestrates; a thin native
// turbo module owns Keychain/Keystore I/O. JS callers see opaque KeyHandles,
// never raw key material.
export {};
