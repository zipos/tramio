// packLoader — read a promoted Offline_Pack into Tour_Engine start config.
//
// Wave 2: Full load-time integrity verification against the persisted
// signed lock envelope. Every asset's SHA-256 and byte size are verified
// before parsing. Missing lock → re-download required. Tampered content →
// PackIntegrityError thrown immediately.

import type { StartTourConfig } from '../../engine/src';
import type { Geofence } from '../../engine/src';
import type { MediaCatalog, PoiMediaEntry } from '../../engine/src';

import type { PackRef } from './paths';
import type { StorageManager } from './manager';
import type { ManifestVerifier, SignedManifest, ManifestLockAsset } from './downloader-types';
import { assertSafePackRelativePath, pathJoin } from './pathJoin';
import { SIGNED_LOCK_RELATIVE_PATH } from './controlFile';
import { PackIntegrityError } from './packIntegrity';
import { extractNarrativeBody } from './extractNarrativeBody';

interface AuthoredRoute {
  bundleId: string;
  polyline: ReadonlyArray<readonly [number, number]>;
  deviationCorridorMeters?: number;
}

interface AuthoredPoi {
  id: string;
  priority: number;
  geometry: Geofence['geometry'];
  dwellSec: number;
  authorIndex?: number;
  narratives?: Readonly<Record<string, string>>;
  /** Pre-rendered audio files keyed by language (ISO 639-1). */
  audio?: Readonly<Record<string, string>>;
  tone?: 'standard' | 'memorial';
}

interface AuthoredPoisFile {
  pois: ReadonlyArray<AuthoredPoi>;
}

export interface LoadedPackTour {
  ref: PackRef;
  packDir: string;
  docsDir: string;
  config: StartTourConfig;
  defaultLanguage: string;
  title: string;
  /** Narrative text keyed by `{poiId}:{lang}` for TTS/captions. */
  narratives: Readonly<Record<string, string>>;
  /** Delivery tone per POI id (not segment id). Absent keys default to 'standard'. */
  tones: Readonly<Record<string, 'standard' | 'memorial'>>;
  /**
   * Per-POI media availability catalog with verified audio asset paths.
   * Passed to the engine's StartTourConfig so selectAudioSource() can
   * resolve pre-rendered audio vs TTS at trigger time.
   */
  mediaCatalog: MediaCatalog;
}

interface AuthoredManifest {
  bundleId: string;
  version: string;
  defaultLanguage: string;
  /** May be absent in partially-authored packs — loader falls back to [defaultLanguage]. */
  languages?: readonly string[];
  transitLine?: { gtfsRouteId?: string; direction?: string; mode?: 'bus' | 'tram' };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new PackIntegrityError('invalid-content', label, 'invalid JSON');
  }
}

/**
 * Verify a single asset's SHA-256 and byte size against the lock entry.
 * Throws PackIntegrityError on mismatch or missing file.
 */
async function verifyAsset(
  storage: StorageManager,
  root: string,
  asset: ManifestLockAsset,
): Promise<void> {
  const fullPath = pathJoin(root, asset.path);
  const fileStat = await storage.fs.stat(fullPath);
  if (fileStat === null || !fileStat.isFile) {
    throw new PackIntegrityError('asset-missing', asset.path);
  }

  const fileSize = await storage.fs.fileSize(fullPath);
  if (fileSize !== null && fileSize !== asset.sizeBytes) {
    throw new PackIntegrityError(
      'size-mismatch',
      asset.path,
      `expected ${asset.sizeBytes} bytes, got ${fileSize}`,
    );
  }

  const actualSha = await storage.fs.sha256Hex(fullPath);
  if (actualSha.toLowerCase() !== asset.sha256.toLowerCase()) {
    throw new PackIntegrityError(
      'hash-mismatch',
      asset.path,
      `expected ${asset.sha256}, got ${actualSha}`,
    );
  }
}

/**
 * Find the lock entry for a given relative path.
 */
function findLockAsset(
  assets: ReadonlyArray<ManifestLockAsset>,
  relPath: string,
): ManifestLockAsset | undefined {
  return assets.find((a) => a.path === relPath);
}

/**
 * Load `route.json`, `pois.json`, and `manifest.json` from an installed pack
 * with full cryptographic integrity verification.
 *
 * ## Load-time integrity (Wave 2)
 *
 * 1. Read the persisted signed lock (`.tramio/MANIFEST.lock.signed.json`).
 * 2. Verify Ed25519 signature via the injected `verifier`.
 * 3. Verify lock identity (bundleId/version) matches the requested ref.
 * 4. Verify `manifest.json`, `route.json`, `pois.json` SHA-256 + byte size.
 * 5. Verify each narrative file referenced by pois.json before returning it.
 *
 * Any failure throws `PackIntegrityError` — never returns unverified content.
 *
 * ## Legacy packs (no persisted lock)
 *
 * Packs installed before Wave 2 have no `.tramio/MANIFEST.lock.signed.json`.
 * They fail with `PackIntegrityError('missing-lock', ...)` — the caller must
 * trigger a re-download. We never implicitly trust legacy packs.
 */
export async function loadPackTour(
  storage: StorageManager,
  ref: PackRef,
  verifier: ManifestVerifier,
  language?: string,
): Promise<LoadedPackTour> {
  const root = storage.packDir(ref);

  // Step 1: Read signed lock control file.
  const lockPath = pathJoin(root, SIGNED_LOCK_RELATIVE_PATH);
  let lockRaw: string;
  try {
    lockRaw = await storage.fs.readUtf8(lockPath);
  } catch {
    throw new PackIntegrityError('missing-lock', SIGNED_LOCK_RELATIVE_PATH);
  }

  let signed: SignedManifest;
  try {
    signed = JSON.parse(lockRaw) as SignedManifest;
  } catch {
    throw new PackIntegrityError(
      'missing-lock',
      SIGNED_LOCK_RELATIVE_PATH,
      'control file is not valid JSON',
    );
  }

  // Step 2: Verify signature.
  const signatureOk = await verifier.verify(signed);
  if (!signatureOk) {
    throw new PackIntegrityError('signature', SIGNED_LOCK_RELATIVE_PATH);
  }

  // Step 3: Verify identity.
  if (signed.payload.bundleId !== ref.bundleId || signed.payload.version !== ref.version) {
    throw new PackIntegrityError(
      'identity-mismatch',
      SIGNED_LOCK_RELATIVE_PATH,
      `lock has ${signed.payload.bundleId}@${signed.payload.version}, expected ${ref.bundleId}@${ref.version}`,
    );
  }

  const lockAssets = signed.payload.assets;

  // Step 4: Verify core assets.
  const coreFiles = ['manifest.json', 'route.json', 'pois.json'] as const;
  for (const coreFile of coreFiles) {
    const lockEntry = findLockAsset(lockAssets, coreFile);
    if (!lockEntry) {
      throw new PackIntegrityError('asset-not-listed', coreFile);
    }
    // eslint-disable-next-line no-await-in-loop
    await verifyAsset(storage, root, lockEntry);
  }

  // Now safe to read and parse.
  const manifestRaw = await storage.fs.readUtf8(pathJoin(root, 'manifest.json'));
  const routeRaw = await storage.fs.readUtf8(pathJoin(root, 'route.json'));
  const poisRaw = await storage.fs.readUtf8(pathJoin(root, 'pois.json'));

  const manifest = parseJson<AuthoredManifest>(manifestRaw, 'manifest.json');
  const route = parseJson<AuthoredRoute>(routeRaw, 'route.json');
  const poisFile = parseJson<AuthoredPoisFile>(poisRaw, 'pois.json');

  const lang = language ?? manifest.defaultLanguage;

  const allLanguages: readonly string[] =
    manifest.languages && manifest.languages.length > 0 ? manifest.languages : [lang];

  const geofences: Geofence[] = poisFile.pois.map((poi, index) => ({
    poiId: poi.id,
    geometry: poi.geometry,
    dwellSec: poi.dwellSec,
    priority: poi.priority,
    authorIndex: poi.authorIndex ?? index,
  }));

  // Step 5: Load and verify narratives.
  const narratives: Record<string, string> = {};
  for (const poi of poisFile.pois) {
    if (!poi.narratives) continue;
    for (const narrativeLang of allLanguages) {
      const relPath = poi.narratives[narrativeLang];
      if (!relPath) continue;

      try {
        assertSafePackRelativePath(relPath);
      } catch {
        throw new PackIntegrityError('asset-missing', relPath, 'unsafe relative path');
      }

      // Verify narrative is in the lock's asset list.
      const lockEntry = findLockAsset(lockAssets, relPath);
      if (!lockEntry) {
        // The narrative is referenced by pois.json but not listed in the lock.
        // This is an integrity failure — the file cannot be verified.
        throw new PackIntegrityError('asset-not-listed', relPath);
      }

      // Verify SHA-256 + size before reading content.
      // eslint-disable-next-line no-await-in-loop
      await verifyAsset(storage, root, lockEntry);

      // eslint-disable-next-line no-await-in-loop
      const text = await storage.fs.readUtf8(pathJoin(root, relPath));
      narratives[`${poi.id}:${narrativeLang}`] = extractNarrativeBody(text.trim(), relPath);
    }
  }

  const tones: Record<string, 'standard' | 'memorial'> = {};
  for (const poi of poisFile.pois) {
    tones[poi.id] = poi.tone === 'memorial' ? 'memorial' : 'standard';
  }

  // Step 6: Verify pre-rendered audio assets — fail closed.
  // For each POI with an `audio` map, every declared audio entry MUST be
  // safe, listed in the lock, present on disk, and pass SHA-256/size
  // verification. A failed or missing declared audio path is an integrity
  // violation (same as narrative) — it throws PackIntegrityError immediately.
  // This prevents silent degradation: if a publisher signs a bundle with
  // audio paths, ALL of them must be intact or the pack is treated as corrupt.
  const verifiedAudio: Record<string, Record<string, string>> = {};
  for (const poi of poisFile.pois) {
    if (!poi.audio) continue;
    const poiAudio: Record<string, string> = {};
    for (const audioLang of Object.keys(poi.audio)) {
      const relPath = poi.audio[audioLang];
      if (!relPath) continue;

      // Unsafe paths are integrity failures — no silent skip.
      try {
        assertSafePackRelativePath(relPath);
      } catch {
        throw new PackIntegrityError('asset-missing', relPath, 'unsafe relative path');
      }

      // Must be listed in the lock.
      const lockEntry = findLockAsset(lockAssets, relPath);
      if (!lockEntry) {
        throw new PackIntegrityError('asset-not-listed', relPath);
      }

      // Verify SHA-256 + size. Throws PackIntegrityError on mismatch/missing.
      // eslint-disable-next-line no-await-in-loop
      await verifyAsset(storage, root, lockEntry);

      // Verified — expose as absolute path for the player.
      poiAudio[audioLang] = pathJoin(root, relPath);
    }
    if (Object.keys(poiAudio).length > 0) {
      verifiedAudio[poi.id] = poiAudio;
    }
  }

  // Build the media catalog for the engine.
  const mediaCatalogPois: Record<string, PoiMediaEntry> = {};
  for (const poi of poisFile.pois) {
    const narrativeMap: Record<string, string> = {};
    if (poi.narratives) {
      for (const narrativeLang of allLanguages) {
        const relPath = poi.narratives[narrativeLang];
        if (relPath && narratives[`${poi.id}:${narrativeLang}`]) {
          // Use the segmentId as the narrative locator (resolver key).
          narrativeMap[narrativeLang] = `${poi.id}:${narrativeLang}`;
        }
      }
    }
    mediaCatalogPois[poi.id] = {
      narratives: narrativeMap,
      audio: verifiedAudio[poi.id] ?? {},
    };
  }

  const mediaCatalog: MediaCatalog = {
    defaultLanguage: manifest.defaultLanguage,
    pois: mediaCatalogPois,
  };

  const vehicleLabel =
    manifest.transitLine?.mode === 'bus'
      ? 'Bus'
      : manifest.transitLine?.mode === 'tram'
        ? 'Tram'
        : 'Line';
  const title =
    manifest.transitLine?.gtfsRouteId != null
      ? `${vehicleLabel} ${manifest.transitLine.gtfsRouteId} — ${manifest.transitLine.direction ?? 'tour'}`
      : manifest.bundleId;

  return {
    ref,
    packDir: root,
    docsDir: storage.layout.docsDir,
    title,
    defaultLanguage: manifest.defaultLanguage,
    narratives,
    tones,
    mediaCatalog,
    config: {
      bundle: { bundleId: ref.bundleId, bundleVersion: ref.version },
      geofences,
      route: route.polyline.map(([lat, lng]) => [lat, lng] as [number, number]),
      language: lang,
      mediaCatalog,
    },
  };
}
