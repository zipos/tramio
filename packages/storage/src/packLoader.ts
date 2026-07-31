// packLoader — read a promoted Offline_Pack into Tour_Engine start config.

import type { StartTourConfig } from '../../engine/src';
import type { Geofence } from '../../engine/src';

import type { PackRef } from './paths';
import type { StorageManager } from './manager';
import { assertSafePackRelativePath } from './pathJoin';

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
    throw new Error(`packLoader: invalid JSON in ${label}`);
  }
}

/**
 * Load `route.json`, `pois.json`, and `manifest.json` from an installed pack.
 * Narrative decryption is deferred; geofences come from plaintext `pois.json`.
 *
 * ## Multi-language eager loading (F5)
 *
 * Narratives are loaded for ALL languages listed in `manifest.languages` so a
 * mid-tour language switch can resolve `{poiId}:{lang}` immediately. The memory
 * cost is bounded: a typical flagship route has 24 POIs × 2 languages × ~1 KB
 * Markdown ≈ 48 KB which is negligible on mobile.
 *
 * ## Integrity (SECURITY NOTE)
 *
 * As of this writing, `loadPackTour` does NOT re-verify asset SHA-256 hashes
 * against MANIFEST.lock.json before parsing. Integrity is only enforced at
 * download time by `OfflinePackDownloader`. A tampered narrative Markdown file
 * that was modified after download (e.g. via a malicious file manager, backup
 * restore, or iCloud sync collision) WILL be loaded and spoken to the user
 * without detection.
 *
 * This is an accepted residual risk documented in task 3 — the downloader's
 * MANIFEST.lock.json envelope is not persisted to disk, so there is no lock
 * file available at load time to compare against. Fixing this requires a
 * design change (persist the signed manifest) that is out of scope for
 * packages/storage alone.
 */
export async function loadPackTour(
  storage: StorageManager,
  ref: PackRef,
  language?: string,
): Promise<LoadedPackTour> {
  const root = storage.packDir(ref);
  const manifestRaw = await storage.fs.readUtf8(`${root}/manifest.json`);
  const routeRaw = await storage.fs.readUtf8(`${root}/route.json`);
  const poisRaw = await storage.fs.readUtf8(`${root}/pois.json`);

  const manifest = parseJson<AuthoredManifest>(manifestRaw, 'manifest.json');
  const route = parseJson<AuthoredRoute>(routeRaw, 'route.json');
  const poisFile = parseJson<AuthoredPoisFile>(poisRaw, 'pois.json');

  const lang = language ?? manifest.defaultLanguage;

  // Resolve the effective language set. Fall back to [defaultLanguage] when
  // manifest.languages is absent (partially-authored packs must not crash).
  const allLanguages: readonly string[] =
    manifest.languages && manifest.languages.length > 0 ? manifest.languages : [lang];

  const geofences: Geofence[] = poisFile.pois.map((poi, index) => ({
    poiId: poi.id,
    geometry: poi.geometry,
    dwellSec: poi.dwellSec,
    priority: poi.priority,
    authorIndex: poi.authorIndex ?? index,
  }));

  // Load narratives for EVERY language in the manifest so the reducer can
  // resolve `{poiId}:{lang}` segments for any language at runtime.
  // Memory note: ~1 KB per POI per language × typical 24 POIs × 2–3 langs ≈ 48–72 KB.
  const narratives: Record<string, string> = {};
  for (const poi of poisFile.pois) {
    if (!poi.narratives) continue;
    for (const narrativeLang of allLanguages) {
      const relPath = poi.narratives[narrativeLang];
      if (!relPath) continue;
      try {
        assertSafePackRelativePath(relPath);
        // eslint-disable-next-line no-await-in-loop
        const text = await storage.fs.readUtf8(`${root}/${relPath}`);
        narratives[`${poi.id}:${narrativeLang}`] = text.trim();
      } catch {
        // Graceful degradation: missing or unreadable narrative files are
        // silently skipped. Authors WILL ship half-translated packs (some
        // POIs missing narratives for non-primary languages). The runtime
        // falls back to a generic line — which is acceptable.
      }
    }
  }

  const tones: Record<string, 'standard' | 'memorial'> = {};
  for (const poi of poisFile.pois) {
    tones[poi.id] = poi.tone === 'memorial' ? 'memorial' : 'standard';
  }

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
    config: {
      bundle: { bundleId: ref.bundleId, bundleVersion: ref.version },
      geofences,
      route: route.polyline.map(([lat, lng]) => [lat, lng] as [number, number]),
      language: lang,
    },
  };
}
