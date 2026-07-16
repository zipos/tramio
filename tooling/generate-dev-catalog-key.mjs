#!/usr/bin/env node
/**
 * Generate a deterministic dev catalog signing keypair and write:
 *   - fixtures/dev/catalog-public-key.json  (public SPKI only — safe to ship in app)
 *   - fixtures/dev/catalog-signing-key.json (private + public — backend dev only)
 *
 * Usage: node tooling/generate-dev-catalog-key.mjs
 */
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeySpkiB64Url = base64urlEncode(publicKey.export({ format: 'der', type: 'spki' }));
const privateKeyPkcs8B64Url = base64urlEncode(privateKey.export({ format: 'der', type: 'pkcs8' }));

// Re-import to verify round-trip
createPublicKey({
  key: Buffer.from(publicKeySpkiB64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  format: 'der',
  type: 'spki',
});

const publicFixture = {
  kid: 'cat-001',
  publicKeySpkiB64Url,
};

const signingFixture = {
  kid: 'cat-001',
  publicKeySpkiB64Url,
  privateKeyPkcs8B64Url,
};

const outDir = join(root, 'fixtures/dev');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'catalog-public-key.json'),
  JSON.stringify(publicFixture, null, 2) + '\n',
);
writeFileSync(
  join(outDir, 'catalog-signing-key.json'),
  JSON.stringify(signingFixture, null, 2) + '\n',
);
console.warn('Wrote fixtures/dev/catalog-public-key.json and catalog-signing-key.json');
