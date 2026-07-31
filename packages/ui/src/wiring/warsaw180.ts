// warsaw180 — Warsaw bus line 180, northbound (Wilanów → Żoliborz).
//
// This is the flagship demo route. It replaces the summer-shortened
// `warsaw-tram-22-east` demo, whose content expired ~2 Aug 2026.
//
// ── Coordinate provenance ────────────────────────────────────────────
// Stop positions were extracted from OpenStreetMap relation 15885943
// ("Bus 180: Wilanów => Chomiczówka") via the public Overpass API on
// 2026-07-31 — no API key required. They are real surveyed stop
// platforms, not hand-placed guesses.
//
//   curl -s -X POST https://overpass-api.de/api/interpreter \
//     --data-urlencode 'data=[out:json][timeout:80];
//       rel["type"="route"]["route"="bus"]["ref"="180"]
//         (52.10,20.85,52.35,21.15)->.r;
//       (.r; node(r.r););
//       out body;'
//
// Replacing this with the official ZTM GTFS feed (stops.txt + shapes.txt)
// remains the correct long-term source — GTFS gives the true road
// geometry between stops, whereas the polyline below interpolates
// stop-to-stop. Tracked as the next authoring-pipeline task.
//
// ── Scope ────────────────────────────────────────────────────────────
// Line 180 runs Wilanów ↔ Chomiczówka (46 stops northbound). This tour
// covers stops 0–35, Wilanów → PKP Powązki, which is the stretch that
// follows the Trakt Królewski and ends on entering Żoliborz. The
// remaining 10 stops to Chomiczówka are outside the authored corridor.
//
// ── Direction ────────────────────────────────────────────────────────
// Northbound only. The southbound relation (15885944) serves platforms
// on the opposite side of the street, which inverts every "on your
// left / on your right" cue, so it must ship as a separate bundle with
// its own narratives. `Geofence.directionFilter` is deliberately NOT
// set here: it is validated per-route during field testing, and an
// untested filter would silently suppress every trigger.
//
// ── Side-of-street claims needing a field check ───────────────────────
// The following left/right assertions in the narratives are asserted
// from map orientation and should be confirmed on an actual northbound
// ride before this ships to users:
//   poi-lazienki       park right, embassies left
//   poi-uniwersytet    main university gate LEFT (west side)
//   poi-bristol        Presidential Palace + Bristol + Europejski all
//                      LEFT (west side); Karowa descends RIGHT
//   poi-swietojerska   Chinese embassy right
//   poi-cmentarz-zydowski  cemetery left (west), Klif right (east)

import type { Geofence } from '../../../engine/src';
import type { StartTourConfig } from '../../../engine/src';

export interface Warsaw180Stop {
  /** Stop name exactly as published by ZTM / OSM. */
  readonly name: string;
  readonly coord: readonly [number, number];
}

/**
 * Stops 0–35 of OSM relation 15885943, in service order northbound.
 * Doubles as the route polyline for the engine's along-route projection.
 */
export const WARSAW_180_NORTH_STOPS: readonly Warsaw180Stop[] = [
  { name: 'Wilanów', coord: [52.16782, 21.08406] },
  { name: 'Kosiarzy', coord: [52.17216, 21.08097] },
  { name: 'Łowcza', coord: [52.17548, 21.07753] },
  { name: 'Wiertnicza', coord: [52.18003, 21.07127] },
  { name: 'Sadyba', coord: [52.18271, 21.06838] },
  { name: 'Goraszewska', coord: [52.18602, 21.06482] },
  { name: 'Limanowskiego', coord: [52.19088, 21.05927] },
  { name: 'Plac Bernardyński', coord: [52.1947, 21.05465] },
  { name: 'Aleja Witosa', coord: [52.19893, 21.05139] },
  { name: 'Chełmska', coord: [52.20373, 21.04957] },
  { name: 'Sielce', coord: [52.20709, 21.04753] },
  { name: 'Iwicka', coord: [52.20678, 21.04289] },
  { name: 'Stępińska', coord: [52.20692, 21.03551] },
  { name: 'Spacerowa', coord: [52.20762, 21.03029] },
  { name: 'Łazienki Królewskie', coord: [52.21443, 21.02649] },
  { name: 'Plac Na Rozdrożu', coord: [52.21968, 21.0252] },
  { name: 'Piękna', coord: [52.22316, 21.02426] },
  { name: 'Plac Trzech Krzyży', coord: [52.22879, 21.02283] },
  { name: 'Foksal', coord: [52.23301, 21.01961] },
  { name: 'Ordynacka', coord: [52.23573, 21.01833] },
  { name: 'Uniwersytet', coord: [52.23918, 21.01724] },
  { name: 'Hotel Bristol', coord: [52.24134, 21.01586] },
  { name: 'Plac Zamkowy', coord: [52.24472, 21.01406] },
  { name: 'Kapitulna', coord: [52.24741, 21.00918] },
  { name: 'Plac Krasińskich', coord: [52.24901, 21.0055] },
  { name: 'Świętojerska', coord: [52.24988, 21.00318] },
  { name: 'Muranów', coord: [52.24923, 20.99818] },
  { name: 'Nalewki-Muzeum', coord: [52.24883, 20.9946] },
  { name: 'Anielewicza', coord: [52.24766, 20.98971] },
  { name: 'Smocza', coord: [52.24641, 20.98571] },
  { name: 'Esperanto', coord: [52.2447, 20.97943] },
  { name: 'Cmentarz Żydowski', coord: [52.24475, 20.97744] },
  { name: 'Niska', coord: [52.24907, 20.97961] },
  { name: 'Powązkowska', coord: [52.25339, 20.97963] },
  { name: 'Powązki-IV Brama', coord: [52.25406, 20.9746] },
  { name: 'PKP Powązki', coord: [52.25606, 20.96936] },
];

/** Route polyline handed to the engine (one vertex per served stop). */
export const WARSAW_180_NORTH_ROUTE: readonly [number, number][] = WARSAW_180_NORTH_STOPS.map(
  (s) => [s.coord[0], s.coord[1]] as [number, number],
);

export interface Warsaw180Poi {
  readonly poiId: string;
  /** Human label shown in the route preview and playback screen. */
  readonly label: string;
  /** Index into WARSAW_180_NORTH_STOPS — anchors the geofence. */
  readonly stopIndex: number;
  /**
   * Trigger radius in metres. Tightened where consecutive stops sit
   * close together so two geofences do not fully overlap:
   *   Esperanto ↔ Cmentarz Żydowski are only ~135 m apart
   *   Plac Krasińskich ↔ Świętojerska  ~185 m
   *   Uniwersytet ↔ Hotel Bristol      ~240 m
   */
  readonly radiusMeters: number;
  /** Higher wins when two geofences overlap. */
  readonly priority: number;
}

/**
 * Authored POIs in service order. `authorIndex` is derived from array
 * position, so ordering here is the tie-breaker for equal priorities.
 */
export const WARSAW_180_NORTH_POIS: readonly Warsaw180Poi[] = [
  { poiId: 'poi-wilanow', label: 'Wilanów (start)', stopIndex: 0, radiusMeters: 140, priority: 95 },
  { poiId: 'poi-sadyba', label: 'Sadyba', stopIndex: 4, radiusMeters: 130, priority: 60 },
  {
    poiId: 'poi-lazienki',
    label: 'Łazienki Królewskie',
    stopIndex: 14,
    radiusMeters: 120,
    priority: 80,
  },
  {
    poiId: 'poi-plac-na-rozdrozu',
    label: 'Plac Na Rozdrożu',
    stopIndex: 15,
    radiusMeters: 110,
    priority: 70,
  },
  { poiId: 'poi-piekna', label: 'Piękna', stopIndex: 16, radiusMeters: 110, priority: 70 },
  {
    poiId: 'poi-trzech-krzyzy',
    label: 'Plac Trzech Krzyży',
    stopIndex: 17,
    radiusMeters: 110,
    priority: 75,
  },
  { poiId: 'poi-foksal', label: 'Foksal / Palma', stopIndex: 18, radiusMeters: 110, priority: 85 },
  { poiId: 'poi-ordynacka', label: 'Ordynacka', stopIndex: 19, radiusMeters: 110, priority: 70 },
  {
    poiId: 'poi-uniwersytet',
    label: 'Uniwersytet',
    stopIndex: 20,
    radiusMeters: 100,
    priority: 80,
  },
  {
    poiId: 'poi-bristol',
    label: 'Hotel Bristol',
    stopIndex: 21,
    radiusMeters: 100,
    priority: 85,
  },
  {
    poiId: 'poi-plac-zamkowy',
    label: 'Plac Zamkowy',
    stopIndex: 22,
    radiusMeters: 110,
    priority: 90,
  },
  { poiId: 'poi-kapitulna', label: 'Kapitulna', stopIndex: 23, radiusMeters: 110, priority: 65 },
  {
    poiId: 'poi-krasinskich',
    label: 'Plac Krasińskich',
    stopIndex: 24,
    radiusMeters: 80,
    priority: 80,
  },
  {
    poiId: 'poi-swietojerska',
    label: 'Świętojerska',
    stopIndex: 25,
    radiusMeters: 80,
    priority: 65,
  },
  { poiId: 'poi-muranow', label: 'Muranów', stopIndex: 26, radiusMeters: 110, priority: 85 },
  {
    poiId: 'poi-polin',
    label: 'Nalewki-Muzeum (POLIN)',
    stopIndex: 27,
    radiusMeters: 110,
    priority: 92,
  },
  {
    poiId: 'poi-anielewicza',
    label: 'Anielewicza',
    stopIndex: 28,
    radiusMeters: 110,
    priority: 88,
  },
  { poiId: 'poi-smocza', label: 'Smocza', stopIndex: 29, radiusMeters: 110, priority: 60 },
  { poiId: 'poi-esperanto', label: 'Esperanto', stopIndex: 30, radiusMeters: 60, priority: 70 },
  {
    poiId: 'poi-cmentarz-zydowski',
    label: 'Cmentarz Żydowski',
    stopIndex: 31,
    radiusMeters: 60,
    priority: 90,
  },
  { poiId: 'poi-niska', label: 'Niska', stopIndex: 32, radiusMeters: 110, priority: 65 },
  {
    poiId: 'poi-powazkowska',
    label: 'Powązkowska',
    stopIndex: 33,
    radiusMeters: 110,
    priority: 65,
  },
  {
    poiId: 'poi-powazki-iv-brama',
    label: 'Powązki-IV Brama',
    stopIndex: 34,
    radiusMeters: 110,
    priority: 88,
  },
  {
    poiId: 'poi-pkp-powazki',
    label: 'PKP Powązki (Żoliborz)',
    stopIndex: 35,
    radiusMeters: 120,
    priority: 95,
  },
];

/** Dwell required inside a geofence before narration fires. */
export const WARSAW_180_DWELL_SEC = 3;

/** Engine geofences derived from the authored POI table. */
export const WARSAW_180_NORTH_GEOFENCES: readonly Geofence[] = WARSAW_180_NORTH_POIS.map(
  (poi, authorIndex): Geofence => {
    const stop = WARSAW_180_NORTH_STOPS[poi.stopIndex];
    if (stop === undefined) {
      throw new Error(`warsaw180: ${poi.poiId} references missing stopIndex ${poi.stopIndex}`);
    }
    return {
      poiId: poi.poiId,
      geometry: {
        kind: 'circle',
        center: stop.coord as readonly [number, number],
        radiusMeters: poi.radiusMeters,
      },
      dwellSec: WARSAW_180_DWELL_SEC,
      priority: poi.priority,
      authorIndex,
    };
  },
);

export const WARSAW_180_NORTH_BUNDLE_ID = 'warsaw-bus-180-north';
export const WARSAW_180_NORTH_BUNDLE_VERSION = '1.0.0';

/** Tour configuration for the northbound 180. */
export const WARSAW_180_NORTH_TOUR_CONFIG: StartTourConfig = {
  bundle: {
    bundleId: WARSAW_180_NORTH_BUNDLE_ID,
    bundleVersion: WARSAW_180_NORTH_BUNDLE_VERSION,
  },
  geofences: WARSAW_180_NORTH_GEOFENCES,
  route: WARSAW_180_NORTH_ROUTE,
  language: 'pl',
};
