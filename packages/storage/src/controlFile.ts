// Control file constants for Offline_Pack integrity.
//
// The signed lock envelope is persisted as an internal control file inside
// every installed pack. It lives under `.tramio/` to avoid collisions with
// authored assets (which use top-level `manifest.json`, `route.json`, etc.).

/**
 * Relative path of the signed manifest lock inside an installed pack.
 * This file contains the EXACT SignedManifest envelope as fetched from the
 * catalog, serialized as JSON. Its signature authenticates the payload;
 * the file itself is NOT listed in the payload's `assets[]`.
 */
export const SIGNED_LOCK_RELATIVE_PATH = '.tramio/MANIFEST.lock.signed.json';

/**
 * Directory holding internal control files inside a pack.
 */
export const CONTROL_DIR = '.tramio';
