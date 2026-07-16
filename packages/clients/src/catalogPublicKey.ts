/**
 * Pinned catalog public key for this repo's signed packs.
 * Private key lives only at fixtures/dev/catalog-signing-key.json (gitignored).
 * Production: inject a rotated SPKI via EAS env / app config — do not ship the fixture key.
 */
import publicKeyFixture from '../../../fixtures/dev/catalog-public-key.json';

export const DEV_CATALOG_KID = publicKeyFixture.kid;
export const DEV_CATALOG_PUBLIC_KEY_SPKI_B64URL = publicKeyFixture.publicKeySpkiB64Url;
