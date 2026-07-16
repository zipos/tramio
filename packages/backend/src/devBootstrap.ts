/**
 * Dev backend bootstrap — deterministic catalog keys + filesystem pack overlay.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { KeyEntry, KeyRegistry } from './keys';
import { createKeyRegistry } from './keys';
import type { BackendStoreOptions } from './store';
import type { CatalogBundleEntry, ManifestLockPayload } from './types';

interface SigningKeyFixture {
  kid: string;
  publicKeySpkiB64Url: string;
  privateKeyPkcs8B64Url: string;
}

function base64urlToBuffer(b64url: string): Buffer {
  const padLen = b64url.length % 4 === 0 ? 0 : 4 - (b64url.length % 4);
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

function keyEntryFromFixture(fixture: SigningKeyFixture, keyClass: 'cat' | 'ent'): KeyEntry {
  const publicKey: KeyObject = createPublicKey({
    key: base64urlToBuffer(fixture.publicKeySpkiB64Url),
    format: 'der',
    type: 'spki',
  });
  const privateKey: KeyObject = createPrivateKey({
    key: base64urlToBuffer(fixture.privateKeyPkcs8B64Url),
    format: 'der',
    type: 'pkcs8',
  });
  return { kid: fixture.kid, keyClass, publicKey, privateKey };
}

export function createDevKeyRegistry(repoRoot: string): KeyRegistry {
  const signingPath = join(repoRoot, 'fixtures/dev/catalog-signing-key.json');
  if (!existsSync(signingPath)) {
    throw new Error(
      `Missing ${signingPath}. Generate with:\n` +
        `  node tooling/generate-dev-catalog-key.mjs && npm run pack:build-warsaw\n` +
        `See fixtures/dev/README.md`,
    );
  }
  const signing = JSON.parse(readFileSync(signingPath, 'utf8')) as SigningKeyFixture;
  const cat = keyEntryFromFixture(signing, 'cat');
  const ent = createKeyRegistry().getActive('ent');
  return createKeyRegistry({ catalog: cat, entitlement: ent });
}

export function createDevBackendStoreOptions(repoRoot: string): BackendStoreOptions {
  const dataDir = join(repoRoot, 'packages/backend/data');
  const catalogPath = join(dataDir, 'catalog.json');
  const manifestsDir = join(dataDir, 'manifests');
  const packsRoot = join(dataDir, 'packs');

  const bundles: CatalogBundleEntry[] = existsSync(catalogPath)
    ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as { bundles: CatalogBundleEntry[] }).bundles
    : [];

  const manifests: ManifestLockPayload[] = [];
  if (existsSync(manifestsDir)) {
    for (const name of readdirSync(manifestsDir)) {
      if (!name.endsWith('.json')) continue;
      manifests.push(
        JSON.parse(readFileSync(join(manifestsDir, name), 'utf8')) as ManifestLockPayload,
      );
    }
  }

  return {
    ...(existsSync(packsRoot) ? { assetRoot: packsRoot } : {}),
    bundles,
    manifests,
    defaultEntitlementExpiry: '2099-01-01T00:00:00.000Z',
    entitlementsByDevice: {
      dev: [{ tier: 'free', grantedAt: '2024-01-01T00:00:00.000Z' }],
    },
  };
}
