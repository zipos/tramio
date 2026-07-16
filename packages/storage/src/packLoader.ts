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
}

interface AuthoredManifest {
  bundleId: string;
  version: string;
  defaultLanguage: string;
  languages: readonly string[];
  transitLine?: { gtfsRouteId?: string; direction?: string };
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
  const geofences: Geofence[] = poisFile.pois.map((poi, index) => ({
    poiId: poi.id,
    geometry: poi.geometry,
    dwellSec: poi.dwellSec,
    priority: poi.priority,
    authorIndex: poi.authorIndex ?? index,
  }));

  const narratives: Record<string, string> = {};
  for (const poi of poisFile.pois) {
    const relPath = poi.narratives?.[lang];
    if (!relPath) continue;
    assertSafePackRelativePath(relPath);
    const text = await storage.fs.readUtf8(`${root}/${relPath}`);
    narratives[`${poi.id}:${lang}`] = text.trim();
  }

  const title =
    manifest.transitLine?.gtfsRouteId != null
      ? `Tram ${manifest.transitLine.gtfsRouteId} — ${manifest.transitLine.direction ?? 'tour'}`
      : manifest.bundleId;

  return {
    ref,
    packDir: root,
    docsDir: storage.layout.docsDir,
    title,
    defaultLanguage: manifest.defaultLanguage,
    narratives,
    config: {
      bundle: { bundleId: ref.bundleId, bundleVersion: ref.version },
      geofences,
      route: route.polyline.map(([lat, lng]) => [lat, lng] as [number, number]),
      language: lang,
    },
  };
}
