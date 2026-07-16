#!/usr/bin/env node
/**
 * Build the Warsaw Tram 22 summer demo Offline_Pack and register it with the dev backend.
 *
 * Writes pack assets to:
 *   packages/backend/data/packs/warsaw-tram-22-east/1.0.0/
 *
 * Usage: node tooling/build-warsaw-dev-pack.mjs
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packRoot = join(root, 'packages/backend/data/packs/warsaw-tram-22-east/1.0.0');
const signingKeyPath = join(root, 'fixtures/dev/catalog-signing-key.json');
if (!existsSync(signingKeyPath)) {
  console.error(
    `Missing ${signingKeyPath}\n` +
      'Run: node tooling/generate-dev-catalog-key.mjs\n' +
      'See fixtures/dev/README.md',
  );
  process.exit(1);
}
const signingKey = JSON.parse(readFileSync(signingKeyPath, 'utf8'));

const bundleId = 'warsaw-tram-22-east';
const version = '1.0.0';

const manifest = {
  bundleId,
  version,
  city: { id: 'warsaw', country: 'PL' },
  transitLine: { gtfsRouteId: '22', direction: 'east (summer)', agency: 'ZTM' },
  languages: ['pl', 'en'],
  defaultLanguage: 'pl',
  minAppVersion: '0.1.0',
  deadReckoning: { permitted: true, maxLeadSeconds: 30 },
  standbyTracks: [],
  attribution: [{ kind: 'osm' }],
  checksumAlgorithm: 'sha256',
  validUntil: '2026-08-02',
  notes: 'Shortened route — terminates at Plac Starynkiewicza until track works complete.',
};

const route = {
  bundleId,
  polyline: [
    [52.244, 21.038],
    [52.241, 21.032],
    [52.237, 21.026],
    [52.233, 21.02],
    [52.2292, 21.0125],
  ],
  stops: [
    { id: 'stop-stadion', gtfsStopId: 'stadion', coord: [52.2394, 21.0455], scheduledOffsetSec: 0 },
    {
      id: 'stop-starynkiewicza',
      gtfsStopId: 'starynkiewicza',
      coord: [52.2292, 21.0125],
      scheduledOffsetSec: 420,
    },
  ],
  deviationCorridorMeters: 120,
};

const pois = {
  pois: [
    {
      id: 'poi-stadion-narodowy',
      category: 'landmark',
      priority: 80,
      geometry: { kind: 'circle', center: [52.2394, 21.0455], radiusMeters: 150 },
      dwellSec: 3,
      tier: 'free',
      narratives: { pl: 'narratives/poi-stadion-narodowy.pl.md' },
    },
    {
      id: 'poi-powisle',
      category: 'architectural-detail',
      priority: 70,
      geometry: { kind: 'circle', center: [52.237, 21.026], radiusMeters: 100 },
      dwellSec: 3,
      tier: 'free',
      narratives: { pl: 'narratives/poi-powisle.pl.md' },
    },
    {
      id: 'poi-starynkiewicza',
      category: 'landmark',
      priority: 90,
      geometry: { kind: 'circle', center: [52.2292, 21.0125], radiusMeters: 80 },
      dwellSec: 3,
      tier: 'free',
      narratives: { pl: 'narratives/poi-starynkiewicza.pl.md' },
    },
  ],
};

const narratives = {
  'narratives/poi-stadion-narodowy.pl.md':
    'PGE Narodowy — stadion zbudowany na ruinach dziesięcioleci. Z okna tramwaju widać jego charakterystyczną konstrukcję.',
  'narratives/poi-powisle.pl.md':
    'Zbliżamy się do Wisły. Ten odcinek Alei Jerozolimskich łączy centrum z Pragą.',
  'narratives/poi-starynkiewicza.pl.md':
    'Koniec trasy letniej — Plac Starynkiewicza. Do początku sierpnia linia 22 kończy tu kurs z powodu remontu torowiska na placu Zawiszy.',
};

// Minimal placeholder vector tile (not valid MVT — sufficient for storage/download pipeline tests).
const tileBytes = Buffer.from([
  0x1a, 0x0a, 0x09, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const tilePath = 'tiles/14/9000/5000.pbf';

const files = {
  'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
  'route.json': Buffer.from(JSON.stringify(route, null, 2) + '\n', 'utf8'),
  'pois.json': Buffer.from(JSON.stringify(pois, null, 2) + '\n', 'utf8'),
  ...Object.fromEntries(
    Object.entries(narratives).map(([path, text]) => [path, Buffer.from(text + '\n', 'utf8')]),
  ),
  [tilePath]: tileBytes,
};

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(value[k])).join(',') +
    '}'
  );
}

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

const assets = Object.entries(files).map(([path, content]) => ({
  path,
  sizeBytes: content.length,
  sha256: sha256Hex(content),
  protected: false,
}));

const lockPayload = {
  bundleId,
  version,
  assets,
  createdAt: new Date().toISOString(),
};

const privateKey = createPrivateKey({
  key: Buffer.from(
    signingKey.privateKeyPkcs8B64Url.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  ),
  format: 'der',
  type: 'pkcs8',
});

const canonical = canonicalJsonStringify(lockPayload);
const signature = base64urlEncode(sign(null, Buffer.from(canonical, 'utf8'), privateKey));

for (const [relPath, content] of Object.entries(files)) {
  const abs = join(packRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

writeFileSync(join(packRoot, 'MANIFEST.lock.json'), JSON.stringify(lockPayload, null, 2) + '\n');
writeFileSync(
  join(packRoot, 'MANIFEST.lock.sig'),
  JSON.stringify({ signature, kid: signingKey.kid }, null, 2) + '\n',
);

const catalogEntry = {
  bundles: [
    {
      bundleId,
      version,
      sizeBytes: assets.reduce((sum, a) => sum + a.sizeBytes, 0),
      requiredAppVersion: '0.1.0',
    },
  ],
};

mkdirSync(join(root, 'packages/backend/data/manifests'), { recursive: true });
writeFileSync(
  join(root, 'packages/backend/data/manifests', `${bundleId}@${version}.json`),
  JSON.stringify(lockPayload, null, 2) + '\n',
);
writeFileSync(
  join(root, 'packages/backend/data/catalog.json'),
  JSON.stringify(catalogEntry, null, 2) + '\n',
);

console.warn(`Built dev pack at ${packRoot} (${assets.length} assets)`);
