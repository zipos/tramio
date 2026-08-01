/**
 * Route-readiness report generator.
 *
 * Analyzes authored route content for Warsaw 180 PL+EN:
 * - Per-narrative word count and estimated duration
 * - Distance/time budget to next POI
 * - Missing translation/media
 * - Overlap/order anomalies
 * - Memorial rate adjustment
 * - Validation/review status where accessible
 *
 * Does NOT pretend human review exists — reports facts only.
 *
 * @module
 */

import type { Geofence, LatLng } from '../../engine/src';
import { haversine } from '../../engine/src';
import { computeNarrationDurationMs } from './runner';

// ─── Report types ───────────────────────────────────────────────────────────

export interface NarrativeReadiness {
  readonly poiId: string;
  readonly label: string;
  readonly stopIndex: number;
  readonly languages: readonly LanguageReadiness[];
  readonly isMemorial: boolean;
  /** Distance to next POI in meters (null for last POI). */
  readonly distToNextM: number | null;
  /** Estimated travel time to next POI at 8 m/s (null for last). */
  readonly travelTimeToNextMs: number | null;
  /** Whether narration might overlap with next POI trigger. */
  readonly overlapRisk: boolean;
  /** Explanation of overlap risk, if any. */
  readonly overlapDetail: string | null;
}

export interface LanguageReadiness {
  readonly lang: string;
  readonly available: boolean;
  readonly wordCount: number;
  /** Estimated speaking duration in ms (accounts for memorial rate). */
  readonly estimatedDurationMs: number;
  /** Time budget: travel time to next POI minus narration duration. */
  readonly timeBudgetMs: number | null;
  /** Whether the narration fits within the travel budget. */
  readonly fitsInBudget: boolean | null;
}

export interface GeofenceAnalysis {
  readonly poiId: string;
  readonly radiusM: number;
  readonly distToNearestNeighborM: number;
  /** True if this geofence's circle overlaps with a neighbor. */
  readonly overlapsNeighbor: boolean;
  readonly neighborId: string | null;
}

export interface RouteReadinessReport {
  readonly routeId: string;
  readonly routeName: string;
  readonly totalPois: number;
  readonly totalLanguages: number;
  readonly narratives: readonly NarrativeReadiness[];
  readonly geofenceAnalysis: readonly GeofenceAnalysis[];
  readonly missingNarratives: readonly { poiId: string; lang: string }[];
  readonly overlapWarnings: readonly string[];
  readonly orderAnomalies: readonly string[];
  /** Summary statistics. */
  readonly summary: ReadinessSummary;
}

export interface ReadinessSummary {
  readonly totalNarratives: number;
  readonly availableNarratives: number;
  readonly missingCount: number;
  readonly memorialCount: number;
  readonly overlapRiskCount: number;
  readonly averageWordCountPl: number;
  readonly averageWordCountEn: number;
  readonly averageDurationMsPl: number;
  readonly averageDurationMsEn: number;
  readonly shortestBudgetMs: number | null;
  readonly longestNarrationMs: number;
}

// ─── Report configuration ───────────────────────────────────────────────────

export interface ReadinessConfig {
  readonly routeId: string;
  readonly routeName: string;
  readonly pois: readonly PoiInfo[];
  readonly geofences: readonly Geofence[];
  readonly route: readonly LatLng[];
  readonly languages: readonly string[];
  /** Narrative text resolver: `${poiId}:${lang}` → text or null. */
  readonly narrativeResolver: (segmentId: string) => string | null;
  /** Memorial POI IDs. */
  readonly memorialPoiIds: readonly string[];
  /** Words per minute for duration estimation (default: 150). */
  readonly wpm?: number;
  /** Average bus speed in m/s (default: 8). */
  readonly busSpeedMps?: number;
}

export interface PoiInfo {
  readonly poiId: string;
  readonly label: string;
  readonly stopIndex: number;
}

// ─── Report generator ───────────────────────────────────────────────────────

/**
 * Generate a route-readiness report.
 *
 * Analyzes all narrative content for completeness, timing budgets,
 * overlap risks, and geofence separation.
 */
export function generateReadinessReport(cfg: ReadinessConfig): RouteReadinessReport {
  const wpm = cfg.wpm ?? 150;
  const busSpeedMps = cfg.busSpeedMps ?? 8;

  const missingNarratives: { poiId: string; lang: string }[] = [];
  const overlapWarnings: string[] = [];
  const orderAnomalies: string[] = [];

  // Compute distances between consecutive POIs
  const poiDistances: (number | null)[] = [];
  for (let i = 0; i < cfg.pois.length; i++) {
    if (i < cfg.pois.length - 1) {
      const current = cfg.pois[i]!;
      const next = cfg.pois[i + 1]!;
      const currentStop = cfg.route[current.stopIndex];
      const nextStop = cfg.route[next.stopIndex];
      if (currentStop && nextStop) {
        poiDistances.push(haversine(currentStop, nextStop));
      } else {
        poiDistances.push(null);
      }
    } else {
      poiDistances.push(null);
    }
  }

  // Analyze narratives
  const narratives: NarrativeReadiness[] = [];
  for (let i = 0; i < cfg.pois.length; i++) {
    const poi = cfg.pois[i]!;
    const isMemorial = cfg.memorialPoiIds.includes(poi.poiId);
    const rateMultiplier = isMemorial ? 0.9 : 1;
    const distToNext = poiDistances[i] ?? null;
    const travelTimeToNext =
      distToNext !== null ? Math.round((distToNext / busSpeedMps) * 1000) : null;

    const languages: LanguageReadiness[] = [];
    let maxDuration = 0;

    for (const lang of cfg.languages) {
      const segmentId = `${poi.poiId}:${lang}`;
      const text = cfg.narrativeResolver(segmentId);
      const available = text !== null;

      if (!available) {
        missingNarratives.push({ poiId: poi.poiId, lang });
      }

      const wordCount = available ? text.split(/\s+/).filter((w) => w.length > 0).length : 0;
      const estimatedDurationMs = available
        ? computeNarrationDurationMs(wordCount, wpm, rateMultiplier)
        : 0;

      if (estimatedDurationMs > maxDuration) maxDuration = estimatedDurationMs;

      const timeBudgetMs =
        travelTimeToNext !== null ? travelTimeToNext - estimatedDurationMs : null;
      const fitsInBudget = timeBudgetMs !== null ? timeBudgetMs >= 0 : null;

      languages.push({
        lang,
        available,
        wordCount,
        estimatedDurationMs,
        timeBudgetMs,
        fitsInBudget,
      });
    }

    const overlapRisk = travelTimeToNext !== null && maxDuration > travelTimeToNext;
    const overlapDetail = overlapRisk
      ? `Narration (${maxDuration}ms) exceeds travel time to next POI (${travelTimeToNext}ms) by ${maxDuration - travelTimeToNext!}ms`
      : null;

    if (overlapRisk) {
      overlapWarnings.push(`${poi.poiId}: ${overlapDetail}`);
    }

    narratives.push({
      poiId: poi.poiId,
      label: poi.label,
      stopIndex: poi.stopIndex,
      languages,
      isMemorial,
      distToNextM: distToNext,
      travelTimeToNextMs: travelTimeToNext,
      overlapRisk,
      overlapDetail,
    });
  }

  // Check author order vs route order
  for (let i = 1; i < cfg.pois.length; i++) {
    const prev = cfg.pois[i - 1]!;
    const cur = cfg.pois[i]!;
    if (cur.stopIndex < prev.stopIndex) {
      orderAnomalies.push(
        `${cur.poiId} (stopIndex=${cur.stopIndex}) appears after ${prev.poiId} (stopIndex=${prev.stopIndex}) but has a lower stopIndex`,
      );
    }
  }

  // Geofence analysis
  const geofenceAnalysis: GeofenceAnalysis[] = [];
  for (let i = 0; i < cfg.geofences.length; i++) {
    const g = cfg.geofences[i]!;
    let minDist = Infinity;
    let nearestId: string | null = null;

    for (let j = 0; j < cfg.geofences.length; j++) {
      if (i === j) continue;
      const other = cfg.geofences[j]!;
      if (g.geometry.kind === 'circle' && other.geometry.kind === 'circle') {
        const dist = haversine(g.geometry.center, other.geometry.center);
        if (dist < minDist) {
          minDist = dist;
          nearestId = other.poiId;
        }
      }
    }

    const radius = g.geometry.kind === 'circle' ? g.geometry.radiusMeters : 0;
    const nearestRadius =
      nearestId !== null
        ? cfg.geofences.find((gf) => gf.poiId === nearestId)?.geometry.kind === 'circle'
          ? (
              cfg.geofences.find((gf) => gf.poiId === nearestId)!.geometry as {
                radiusMeters: number;
              }
            ).radiusMeters
          : 0
        : 0;
    const overlapsNeighbor = minDist < radius + nearestRadius;

    geofenceAnalysis.push({
      poiId: g.poiId,
      radiusM: radius,
      distToNearestNeighborM: minDist === Infinity ? 0 : Math.round(minDist),
      overlapsNeighbor,
      neighborId: nearestId,
    });
  }

  // Summary statistics
  const plNarratives = narratives.flatMap((n) =>
    n.languages.filter((l) => l.lang === 'pl' && l.available),
  );
  const enNarratives = narratives.flatMap((n) =>
    n.languages.filter((l) => l.lang === 'en' && l.available),
  );

  const avgWordsPl =
    plNarratives.length > 0
      ? Math.round(plNarratives.reduce((s, n) => s + n.wordCount, 0) / plNarratives.length)
      : 0;
  const avgWordsEn =
    enNarratives.length > 0
      ? Math.round(enNarratives.reduce((s, n) => s + n.wordCount, 0) / enNarratives.length)
      : 0;
  const avgDurPl =
    plNarratives.length > 0
      ? Math.round(
          plNarratives.reduce((s, n) => s + n.estimatedDurationMs, 0) / plNarratives.length,
        )
      : 0;
  const avgDurEn =
    enNarratives.length > 0
      ? Math.round(
          enNarratives.reduce((s, n) => s + n.estimatedDurationMs, 0) / enNarratives.length,
        )
      : 0;

  const allBudgets = narratives
    .flatMap((n) => n.languages.map((l) => l.timeBudgetMs))
    .filter((b): b is number => b !== null);
  const shortestBudget = allBudgets.length > 0 ? Math.min(...allBudgets) : null;

  const allDurations = narratives.flatMap((n) => n.languages.map((l) => l.estimatedDurationMs));
  const longestNarration = Math.max(...allDurations, 0);

  const summary: ReadinessSummary = {
    totalNarratives: cfg.pois.length * cfg.languages.length,
    availableNarratives: cfg.pois.length * cfg.languages.length - missingNarratives.length,
    missingCount: missingNarratives.length,
    memorialCount:
      cfg.pois.length > 0 ? cfg.pois.filter((p) => cfg.memorialPoiIds.includes(p.poiId)).length : 0,
    overlapRiskCount: overlapWarnings.length,
    averageWordCountPl: avgWordsPl,
    averageWordCountEn: avgWordsEn,
    averageDurationMsPl: avgDurPl,
    averageDurationMsEn: avgDurEn,
    shortestBudgetMs: shortestBudget,
    longestNarrationMs: longestNarration,
  };

  return {
    routeId: cfg.routeId,
    routeName: cfg.routeName,
    totalPois: cfg.pois.length,
    totalLanguages: cfg.languages.length,
    narratives,
    geofenceAnalysis,
    missingNarratives,
    overlapWarnings,
    orderAnomalies,
    summary,
  };
}
