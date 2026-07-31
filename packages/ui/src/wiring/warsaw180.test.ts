// warsaw180 — authoring invariants for the bus 180 northbound route.
//
// These tests guard the *content*, not the engine. They exist because the
// first draft of this route shipped several classes of authoring bug that
// are invisible until you are on the bus:
//   • a stop listed twice, and two stops in the wrong order
//   • narration that instructed the listener to operate the app
//   • unverifiable statistics used as flavour
//   • a factual error about the wall at Powązki-IV Brama
//   • geofences placed close enough together to fight each other
// Each of those now has a corresponding assertion.

import {
  WARSAW_180_DWELL_SEC,
  WARSAW_180_NORTH_GEOFENCES,
  WARSAW_180_NORTH_POIS,
  WARSAW_180_NORTH_ROUTE,
  WARSAW_180_NORTH_STOPS,
  WARSAW_180_NORTH_TOUR_CONFIG,
} from './warsaw180';
import {
  MEMORIAL_POI_IDS,
  warsaw180Narratives,
  warsaw180NarrativeResolver,
  warsaw180SegmentStyle,
} from './warsaw180Narratives';

const LANGUAGES = ['pl', 'en'] as const;

/** Great-circle distance in metres. */
function distanceM(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

describe('warsaw180 route geometry', () => {
  it('covers the authored Wilanów → PKP Powązki corridor', () => {
    expect(WARSAW_180_NORTH_STOPS).toHaveLength(36);
    expect(WARSAW_180_NORTH_STOPS[0]?.name).toBe('Wilanów');
    expect(WARSAW_180_NORTH_STOPS[35]?.name).toBe('PKP Powązki');
    expect(WARSAW_180_NORTH_ROUTE).toHaveLength(WARSAW_180_NORTH_STOPS.length);
  });

  it('places every stop inside the Warsaw bounding box', () => {
    for (const stop of WARSAW_180_NORTH_STOPS) {
      const [lat, lon] = stop.coord;
      expect(lat).toBeGreaterThan(52.1);
      expect(lat).toBeLessThan(52.35);
      expect(lon).toBeGreaterThan(20.85);
      expect(lon).toBeLessThan(21.15);
    }
  });

  it('has no duplicate stop names', () => {
    const names = WARSAW_180_NORTH_STOPS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('orders Łazienki Królewskie before Plac Na Rozdrożu before Piękna', () => {
    // The original field notes had Piękna before Plac Na Rozdrożu, and
    // listed Plac Na Rozdrożu twice.
    const indexOf = (name: string): number =>
      WARSAW_180_NORTH_STOPS.findIndex((s) => s.name === name);
    expect(indexOf('Łazienki Królewskie')).toBeLessThan(indexOf('Plac Na Rozdrożu'));
    expect(indexOf('Plac Na Rozdrożu')).toBeLessThan(indexOf('Piękna'));
    expect(indexOf('Piękna')).toBeLessThan(indexOf('Plac Trzech Krzyży'));
  });

  it('keeps consecutive stops within a plausible urban spacing', () => {
    for (let i = 1; i < WARSAW_180_NORTH_STOPS.length; i += 1) {
      const prev = WARSAW_180_NORTH_STOPS[i - 1]!;
      const curr = WARSAW_180_NORTH_STOPS[i]!;
      const d = distanceM(prev.coord, curr.coord);
      expect(d).toBeGreaterThan(50);
      expect(d).toBeLessThan(1_200);
    }
  });
});

describe('warsaw180 POIs and geofences', () => {
  it('assigns each POI a unique id', () => {
    const ids = WARSAW_180_NORTH_POIS.map((p) => p.poiId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('anchors every POI to a real stop, in service order', () => {
    let previous = -1;
    for (const poi of WARSAW_180_NORTH_POIS) {
      expect(WARSAW_180_NORTH_STOPS[poi.stopIndex]).toBeDefined();
      expect(poi.stopIndex).toBeGreaterThan(previous);
      previous = poi.stopIndex;
    }
  });

  it('derives geofences with positional authorIndex and shared dwell', () => {
    expect(WARSAW_180_NORTH_GEOFENCES).toHaveLength(WARSAW_180_NORTH_POIS.length);
    WARSAW_180_NORTH_GEOFENCES.forEach((gf, i) => {
      expect(gf.authorIndex).toBe(i);
      expect(gf.poiId).toBe(WARSAW_180_NORTH_POIS[i]?.poiId);
      expect(gf.dwellSec).toBe(WARSAW_180_DWELL_SEC);
      expect(gf.geometry.kind).toBe('circle');
      if (gf.geometry.kind === 'circle') {
        expect(gf.geometry.radiusMeters).toBeGreaterThanOrEqual(50);
        expect(gf.geometry.radiusMeters).toBeLessThanOrEqual(200);
        expect(gf.geometry.center).toEqual(
          WARSAW_180_NORTH_STOPS[WARSAW_180_NORTH_POIS[i]!.stopIndex]!.coord,
        );
      }
    });
  });

  it('never lets two geofences overlap', () => {
    // Overlapping circles make which POI fires depend on GPS noise. The
    // engine can resolve them by priority, but authored content should
    // not rely on that. Tight pairs on this route are Esperanto ↔
    // Cmentarz Żydowski (~135 m) and Plac Krasińskich ↔ Świętojerska
    // (~185 m), which is why their radii are reduced.
    const circles = WARSAW_180_NORTH_GEOFENCES.flatMap((gf) =>
      gf.geometry.kind === 'circle'
        ? [{ poiId: gf.poiId, center: gf.geometry.center, r: gf.geometry.radiusMeters }]
        : [],
    );
    for (let i = 0; i < circles.length; i += 1) {
      for (let j = i + 1; j < circles.length; j += 1) {
        const a = circles[i]!;
        const b = circles[j]!;
        const gap = distanceM(a.center, b.center) - (a.r + b.r);
        expect({ pair: `${a.poiId} ↔ ${b.poiId}`, overlaps: gap <= 0 }).toEqual({
          pair: `${a.poiId} ↔ ${b.poiId}`,
          overlaps: false,
        });
      }
    }
  });

  it('exposes a valid tour config', () => {
    expect(WARSAW_180_NORTH_TOUR_CONFIG.bundle.bundleId).toBe('warsaw-bus-180-north');
    expect(WARSAW_180_NORTH_TOUR_CONFIG.language).toBe('pl');
    expect(WARSAW_180_NORTH_TOUR_CONFIG.geofences).toBe(WARSAW_180_NORTH_GEOFENCES);
    expect(WARSAW_180_NORTH_TOUR_CONFIG.route).toBe(WARSAW_180_NORTH_ROUTE);
  });
});

describe('warsaw180 narratives', () => {
  it('provides Polish and English text for every POI', () => {
    for (const poi of WARSAW_180_NORTH_POIS) {
      for (const lang of LANGUAGES) {
        const text = warsaw180NarrativeResolver(`${poi.poiId}:${lang}`);
        expect(typeof text).toBe('string');
        expect((text ?? '').trim().length).toBeGreaterThan(20);
      }
    }
  });

  it('contains no narratives for unknown POIs', () => {
    const known = new Set(WARSAW_180_NORTH_POIS.map((p) => p.poiId));
    for (const segmentId of Object.keys(warsaw180Narratives())) {
      const [poiId, lang] = [
        segmentId.slice(0, segmentId.lastIndexOf(':')),
        segmentId.slice(segmentId.lastIndexOf(':') + 1),
      ];
      expect(known.has(poiId)).toBe(true);
      expect(LANGUAGES).toContain(lang as (typeof LANGUAGES)[number]);
    }
  });

  it('fits the spoken-duration budget between stops', () => {
    // ~2.6 words/second for TTS at rate 1.0. Stops on the Trakt
    // Królewski are 250–400 m apart, so a segment that runs long is
    // still talking when the next POI triggers.
    const WORDS_PER_SEC = 2.6;
    const MAX_SEC = 40;
    for (const [segmentId, text] of Object.entries(warsaw180Narratives())) {
      const words = text.split(/\s+/).filter(Boolean).length;
      const seconds = words / WORDS_PER_SEC;
      expect({ segmentId, overBudget: seconds > MAX_SEC }).toEqual({
        segmentId,
        overBudget: false,
      });
    }
  });

  it('never instructs the listener to operate the app', () => {
    // The draft told the listener to "skip backwards on the phone media
    // player". App affordances belong in the UI, not in the narration.
    const banned = [
      'media player',
      'skip back',
      'skip backwards',
      'przewiń',
      'odtwarzacz',
      'touristic line 180',
      'linii 180', // self-referential interchange announcement
    ];
    for (const [segmentId, text] of Object.entries(warsaw180Narratives())) {
      const lower = text.toLowerCase();
      for (const phrase of banned) {
        expect({ segmentId, phrase, present: lower.includes(phrase) }).toEqual({
          segmentId,
          phrase,
          present: false,
        });
      }
    }
  });

  it('uses no percentage statistics as flavour', () => {
    for (const [segmentId, text] of Object.entries(warsaw180Narratives())) {
      expect({ segmentId, hasPercent: text.includes('%') }).toEqual({
        segmentId,
        hasPercent: false,
      });
    }
  });

  it('corrects the Powązki wall rather than repeating the ghetto-wall claim', () => {
    // The wall at Powązki-IV Brama is the Catholic Powązki cemetery
    // wall, not a ghetto wall. Surviving ghetto wall fragments stand on
    // Sienna and Waliców.
    const en = warsaw180NarrativeResolver('poi-powazki-iv-brama:en') ?? '';
    const pl = warsaw180NarrativeResolver('poi-powazki-iv-brama:pl') ?? '';
    expect(en).toContain('not a ghetto wall');
    expect(pl).toContain('Nie jest to mur getta');
  });
});

describe('warsaw180 delivery register', () => {
  it('marks memorial POIs that all exist on the route', () => {
    const known = new Set(WARSAW_180_NORTH_POIS.map((p) => p.poiId));
    for (const poiId of MEMORIAL_POI_IDS) {
      expect(known.has(poiId)).toBe(true);
    }
  });

  it('slows delivery for memorial segments only', () => {
    for (const poi of WARSAW_180_NORTH_POIS) {
      for (const lang of LANGUAGES) {
        const style = warsaw180SegmentStyle(`${poi.poiId}:${lang}`);
        if (MEMORIAL_POI_IDS.includes(poi.poiId)) {
          expect(style.tone).toBe('memorial');
          expect(style.rateMultiplier).toBeLessThan(1);
        } else {
          expect(style.tone).toBe('standard');
          expect(style.rateMultiplier).toBe(1);
        }
      }
    }
  });

  it('covers the Holocaust and cemetery stretch', () => {
    expect(MEMORIAL_POI_IDS).toContain('poi-polin');
    expect(MEMORIAL_POI_IDS).toContain('poi-cmentarz-zydowski');
    expect(MEMORIAL_POI_IDS).toContain('poi-powazki-iv-brama');
    // Adjacent light content must NOT be memorial-toned, otherwise the
    // register shift loses its meaning.
    expect(MEMORIAL_POI_IDS).not.toContain('poi-smocza');
    expect(MEMORIAL_POI_IDS).not.toContain('poi-esperanto');
  });
});

describe('warsaw180 fact-check regression guards', () => {
  it('poi-muranow does not claim construction has begun', () => {
    const pl = warsaw180NarrativeResolver('poi-muranow:pl') ?? '';
    const en = warsaw180NarrativeResolver('poi-muranow:en') ?? '';
    // The station was never built and construction has not started.
    expect({
      segment: 'poi-muranow:en',
      contains: en.includes('construction finally began'),
    }).toEqual({
      segment: 'poi-muranow:en',
      contains: false,
    });
    expect({ segment: 'poi-muranow:pl', contains: pl.includes('zaczęła się') }).toEqual({
      segment: 'poi-muranow:pl',
      contains: false,
    });
    expect({ segment: 'poi-muranow:pl', contains: pl.includes('budowa zaczęła') }).toEqual({
      segment: 'poi-muranow:pl',
      contains: false,
    });
    // Must mention Plac Konstytucji as the parallel case.
    expect({ segment: 'poi-muranow:en', mentionsKonstytucji: en.includes('Konstytucji') }).toEqual({
      segment: 'poi-muranow:en',
      mentionsKonstytucji: true,
    });
    expect({ segment: 'poi-muranow:pl', mentionsKonstytucji: pl.includes('Konstytucji') }).toEqual({
      segment: 'poi-muranow:pl',
      mentionsKonstytucji: true,
    });
  });

  it('poi-anielewicza does not claim he was twenty-four', () => {
    const pl = warsaw180NarrativeResolver('poi-anielewicza:pl') ?? '';
    const en = warsaw180NarrativeResolver('poi-anielewicza:en') ?? '';
    expect({ segment: 'poi-anielewicza:pl', contains: pl.includes('dwadzieścia cztery') }).toEqual({
      segment: 'poi-anielewicza:pl',
      contains: false,
    });
    expect({ segment: 'poi-anielewicza:en', contains: en.includes('twenty-four') }).toEqual({
      segment: 'poi-anielewicza:en',
      contains: false,
    });
  });

  it('poi-sadyba covers the 1920s, not only the 1930s', () => {
    const pl = warsaw180NarrativeResolver('poi-sadyba:pl') ?? '';
    const en = warsaw180NarrativeResolver('poi-sadyba:en') ?? '';
    expect({ segment: 'poi-sadyba:pl', contains: pl.includes('dwudziestych') }).toEqual({
      segment: 'poi-sadyba:pl',
      contains: true,
    });
    expect({ segment: 'poi-sadyba:en', contains: en.includes('1920s') }).toEqual({
      segment: 'poi-sadyba:en',
      contains: true,
    });
  });

  it('poi-esperanto says "published" not "invented"', () => {
    const pl = warsaw180NarrativeResolver('poi-esperanto:pl') ?? '';
    const en = warsaw180NarrativeResolver('poi-esperanto:en') ?? '';
    expect({ segment: 'poi-esperanto:pl', contains: pl.includes('wymyślonego') }).toEqual({
      segment: 'poi-esperanto:pl',
      contains: false,
    });
    expect({ segment: 'poi-esperanto:en', contains: en.includes('invented') }).toEqual({
      segment: 'poi-esperanto:en',
      contains: false,
    });
  });
});
