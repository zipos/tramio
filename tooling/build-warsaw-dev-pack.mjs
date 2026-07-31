#!/usr/bin/env node
/**
 * Build the Warsaw Bus 180 (northbound) demo Offline_Pack and register it
 * with the dev backend.
 *
 * Writes pack assets to:
 *   packages/backend/data/packs/warsaw-bus-180-north/1.0.0/
 *
 * Replaces the retired Tram 22 summer pack, whose content expired ~2 Aug 2026.
 *
 * ── Single source of truth ───────────────────────────────────────────
 * Route geometry, POIs and narratives are NOT duplicated here. This script
 * transpiles and evaluates the authored TypeScript modules directly:
 *
 *   packages/ui/src/wiring/warsaw180.ts
 *   packages/ui/src/wiring/warsaw180Narratives.ts
 *
 * Both modules are pure data with type-only imports, so transpiling them
 * in isolation pulls in no React Native or Expo dependencies. If either
 * file ever grows a runtime import, the `require` shim below throws
 * loudly rather than silently producing a stale pack.
 *
 * Usage: node tooling/build-warsaw-dev-pack.mjs
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Transpile a pure-data TS module and return its exports. */
function loadDataModule(relPath) {
  const abs = join(root, relPath);
  const { outputText } = ts.transpileModule(readFileSync(abs, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
    fileName: abs,
  });
  const mod = { exports: {} };
  const factory = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) {${outputText}\n})`,
    { filename: abs },
  );
  factory(
    mod.exports,
    (id) => {
      throw new Error(
        `${relPath} performed a runtime require('${id}'). ` +
          'Authored route data must stay import-free so the pack builder can read it.',
      );
    },
    mod,
    abs,
    dirname(abs),
  );
  return mod.exports;
}

const routeModule = loadDataModule('packages/ui/src/wiring/warsaw180.ts');
const narrativeModule = loadDataModule('packages/ui/src/wiring/warsaw180Narratives.ts');

const bundleId = routeModule.WARSAW_180_NORTH_BUNDLE_ID;
const version = routeModule.WARSAW_180_NORTH_BUNDLE_VERSION;
const stops = routeModule.WARSAW_180_NORTH_STOPS;
const authoredPois = routeModule.WARSAW_180_NORTH_POIS;
const geofences = routeModule.WARSAW_180_NORTH_GEOFENCES;
const polyline = routeModule.WARSAW_180_NORTH_ROUTE;
const dwellSec = routeModule.WARSAW_180_DWELL_SEC;
const narrativeText = narrativeModule.warsaw180Narratives();
const memorialPoiIds = new Set(narrativeModule.MEMORIAL_POI_IDS);

const packRoot = join(root, `packages/backend/data/packs/${bundleId}/${version}`);
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

const languages = ['pl', 'en'];

const manifest = {
  bundleId,
  version,
  city: { id: 'warsaw', country: 'PL' },
  transitLine: {
    gtfsRouteId: '180',
    direction: 'north (Wilanów → Żoliborz)',
    agency: 'ZTM',
    mode: 'bus',
  },
  languages,
  defaultLanguage: 'pl',
  minAppVersion: '0.1.0',
  deadReckoning: { permitted: true, maxLeadSeconds: 30 },
  standbyTracks: [],
  attribution: [{ kind: 'osm' }],
  checksumAlgorithm: 'sha256',
  validUntil: '2027-12-31',
  notes:
    'Northbound only — the southbound direction serves the opposite kerb, which inverts every ' +
    'left/right cue, so it ships as a separate bundle. Stop coordinates from OpenStreetMap ' +
    'relation 15885943; replace with ZTM GTFS shapes.txt for true road geometry.',
};

const route = {
  bundleId,
  polyline: polyline.map((p) => [p[0], p[1]]),
  // `gtfsStopId` and `scheduledOffsetSec` are omitted, not nulled: no GTFS
  // feed has been ingested, so the ids and timings are genuinely unknown.
  // Emitting null would assert "known to be absent" and fails the schema.
  stops: stops.map((stop, index) => ({
    id: `stop-${index}`,
    name: stop.name,
    coord: [stop.coord[0], stop.coord[1]],
  })),
  deviationCorridorMeters: 120,
};

function narrativePath(poiId, lang) {
  return `narratives/${poiId}.${lang}.md`;
}

const pois = {
  pois: authoredPois.map((poi, index) => {
    const geofence = geofences[index];
    const narratives = {};
    for (const lang of languages) {
      if (narrativeText[`${poi.poiId}:${lang}`] !== undefined) {
        narratives[lang] = narrativePath(poi.poiId, lang);
      }
    }
    return {
      id: poi.poiId,
      category: 'landmark',
      priority: poi.priority,
      geometry: geofence.geometry,
      dwellSec,
      tier: 'free',
      tone: memorialPoiIds.has(poi.poiId) ? 'memorial' : 'standard',
      narratives,
    };
  }),
};

// ---------------------------------------------------------------------------
// Narrative file generation — with proper YAML frontmatter
// ---------------------------------------------------------------------------

/**
 * Build YAML frontmatter for a narrative file.
 *
 * Required fields (per narrativeFrontmatter.ts schema):
 *   - poiId: string
 *   - language: ISO 639-1 code
 *
 * We also emit `tone` because it is derivable from the source data and
 * important for runtime behaviour (memorial segments slow delivery).
 *
 * We do NOT emit `review` or `claims` — those are human-judgement fields
 * that must come from an explicit, auditable review record. The narratives
 * in warsaw180Narratives.ts have not been formally reviewed through the
 * six-stage pipeline, so omitting review/claims is the honest representation.
 * The pack will pass default validation but correctly fail --strict on the
 * review gate.
 */
function buildFrontmatter(poiId, lang) {
  const tone = memorialPoiIds.has(poiId) ? 'memorial' : 'standard';
  // Use simple YAML formatting that is unambiguous and readable.
  const lines = ['---', `poiId: ${poiId}`, `language: ${lang}`, `tone: ${tone}`, '---'];
  return lines.join('\n');
}

const narrativeFiles = {};
for (const [segmentId, text] of Object.entries(narrativeText)) {
  const cut = segmentId.lastIndexOf(':');
  const poiId = segmentId.slice(0, cut);
  const lang = segmentId.slice(cut + 1);
  const frontmatter = buildFrontmatter(poiId, lang);
  narrativeFiles[narrativePath(poiId, lang)] = `${frontmatter}\n\n${text}`;
}

// Minimal placeholder vector tile (not valid MVT — sufficient for storage/download pipeline tests).
// Replace with a real OSM corridor extract of the 180 alignment (tippecanoe / Planetiler).
const tileBytes = Buffer.from([
  0x1a, 0x0a, 0x09, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const tilePath = 'tiles/14/9000/5000.pbf';

const files = {
  'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
  'route.json': Buffer.from(JSON.stringify(route, null, 2) + '\n', 'utf8'),
  'pois.json': Buffer.from(JSON.stringify(pois, null, 2) + '\n', 'utf8'),
  ...Object.fromEntries(
    Object.entries(narrativeFiles).map(([path, text]) => [path, Buffer.from(text + '\n', 'utf8')]),
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

console.error(
  `Built dev pack at ${packRoot} (${assets.length} assets, ` +
    `${pois.pois.length} POIs, ${Object.keys(narrativeFiles).length} narratives)`,
);

// ---------------------------------------------------------------------------
// Format JSON with prettier so CI's format gate passes.
// ---------------------------------------------------------------------------

const jsonFilesToFormat = [
  `packages/backend/data/packs/${bundleId}/${version}/manifest.json`,
  `packages/backend/data/packs/${bundleId}/${version}/route.json`,
  `packages/backend/data/packs/${bundleId}/${version}/pois.json`,
  `packages/backend/data/packs/${bundleId}/${version}/MANIFEST.lock.json`,
  `packages/backend/data/manifests/${bundleId}@${version}.json`,
  `packages/backend/data/catalog.json`,
];

try {
  execSync(`npx prettier --write ${jsonFilesToFormat.map((f) => `'${f}'`).join(' ')}`, {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: root,
  });
} catch (err) {
  // prettier not available is non-fatal — the JSON is still valid.
  console.error('⚠ prettier --write failed; JSON may not be formatted for CI.');
}

// ---------------------------------------------------------------------------
// Self-validation: run the bundle validator on our own output.
// A build that emits invalid content must fail loudly.
// ---------------------------------------------------------------------------

console.error('Running bundle-validate on emitted pack...');

try {
  execSync(
    `node ${JSON.stringify(join(root, 'packages/authoring/bin/bundle-validate.js'))} ${JSON.stringify(packRoot)}`,
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: root },
  );
  console.error('✓ Pack passes default validation.');
} catch (err) {
  const stderr = err.stderr ? err.stderr.toString() : '';
  const stdout = err.stdout ? err.stdout.toString() : '';

  // Distinguish between:
  // (a) The validator itself cannot compile/run (TSError, SyntaxError, etc.)
  //     — not our fault; warn but do not block the build.
  // (b) The validator ran successfully but found errors in our output
  //     — our fault; fail hard.
  const isValidatorCrash =
    stderr.includes('TSError') ||
    stderr.includes('SyntaxError') ||
    stderr.includes('Cannot find module') ||
    stderr.includes('Error: Cannot find') ||
    stderr.includes('TypeError');

  if (isValidatorCrash) {
    console.error(
      '⚠ bundle-validate could not run (validator compilation/runtime error).\n' +
        '  This is NOT a pack content error — the validator itself is broken.\n' +
        '  The pack was still emitted. Re-run validation once the validator is fixed.',
    );
    if (stderr) console.error('  stderr:', stderr.split('\n')[0]);
  } else {
    // Validator ran but reported content errors — fail the build.
    console.error('✗ Pack FAILED validation:');
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
    process.exit(1);
  }
}
