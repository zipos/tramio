/* eslint-disable no-console */
/**
 * CLI entry point: `npm run simulate:180`
 *
 * Runs the deterministic Warsaw 180 simulation and readiness report,
 * prints dense human-readable output, and exits with nonzero on failures.
 *
 * @module
 */

import { generateDwellTrace } from './generators';
import { generateReadinessReport } from './readiness';
import { runSimulation } from './runner';
import {
  warsaw180PoiCenters,
  warsaw180ReadinessConfig,
  warsaw180RunnerConfig,
} from './warsaw180Config';
import { WARSAW_180_NORTH_POIS } from './warsaw180Config';

// ─── Simulation ─────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════');
console.log('  TRAMIO SIMULATOR — Warsaw Bus 180 Northbound');
console.log('═══════════════════════════════════════════════════════════════\n');

// Generate a clean trace with dwell at each POI center
const poiCenters = warsaw180PoiCenters();
const trace = generateDwellTrace(poiCenters, 4000, {
  speedMps: 8,
  fixIntervalMs: 1000,
  accuracyM: 10,
});

console.log(`Trace: ${trace.length} events, ${poiCenters.length} POI waypoints\n`);

// Run with Polish narration
const configPl = warsaw180RunnerConfig('pl');
const reportPl = runSimulation(trace, configPl);

console.log('── Simulation Results (PL) ────────────────────────────────────');
console.log(`  Duration:        ${(reportPl.durationMs / 1000).toFixed(1)}s`);
console.log(`  Accepted fixes:  ${reportPl.acceptedFixes}`);
console.log(`  Rejected fixes:  ${reportPl.rejectedFixes}`);
if (reportPl.rejectedFixes > 0) {
  console.log(`  Rejection reasons: ${JSON.stringify(reportPl.rejectionReasons)}`);
}
console.log(`  POIs fired:      ${reportPl.firedPois.length} / ${WARSAW_180_NORTH_POIS.length}`);
console.log(`  POIs consumed:   ${reportPl.consumedPois.length}`);
console.log(`  Stuck playing:   ${reportPl.stuckPlaying ? 'YES ⚠️' : 'no'}`);
console.log(`  Final phase:     ${reportPl.finalPhase}`);
console.log(`  Warnings:        ${reportPl.warnings.length}`);
console.log(`  Errors:          ${reportPl.errors.length}`);

if (reportPl.firedPois.length > 0) {
  console.log('\n  Fired POIs in order:');
  for (const poiId of reportPl.firedPois) {
    const poi = WARSAW_180_NORTH_POIS.find((p) => p.poiId === poiId);
    const detail = reportPl.triggerDetails.find((t) => t.poiId === poiId);
    const duration = detail ? `${(detail.narrationDurationMs / 1000).toFixed(1)}s` : '?';
    const latency =
      detail?.triggerLatencyMs != null ? `lat=${(detail.triggerLatencyMs / 1000).toFixed(1)}s` : '';
    console.log(`    ${poiId.padEnd(28)} ${poi?.label ?? ''} [${duration}] ${latency}`);
  }
}

if (reportPl.warnings.length > 0) {
  console.log('\n  Warnings:');
  for (const w of reportPl.warnings) {
    console.log(`    ⚠️  ${w}`);
  }
}

if (reportPl.errors.length > 0) {
  console.log('\n  Errors:');
  for (const e of reportPl.errors) {
    console.log(`    ❌  ${e}`);
  }
}

// ─── Readiness Report ───────────────────────────────────────────────────────

console.log('\n\n── Route Readiness Report ──────────────────────────────────────\n');

const readinessCfg = warsaw180ReadinessConfig();
const readiness = generateReadinessReport(readinessCfg);

console.log(`  Route:       ${readiness.routeName}`);
console.log(`  POIs:        ${readiness.totalPois}`);
console.log(`  Languages:   ${readiness.totalLanguages} (pl, en)`);
console.log(
  `  Available:   ${readiness.summary.availableNarratives} / ${readiness.summary.totalNarratives}`,
);
console.log(`  Missing:     ${readiness.summary.missingCount}`);
console.log(`  Memorial:    ${readiness.summary.memorialCount}`);
console.log(`  Overlap risk:${readiness.summary.overlapRiskCount}`);
console.log(`  Avg words PL:${readiness.summary.averageWordCountPl}`);
console.log(`  Avg words EN:${readiness.summary.averageWordCountEn}`);
console.log(`  Avg dur PL:  ${(readiness.summary.averageDurationMsPl / 1000).toFixed(1)}s`);
console.log(`  Avg dur EN:  ${(readiness.summary.averageDurationMsEn / 1000).toFixed(1)}s`);
console.log(`  Longest nar: ${(readiness.summary.longestNarrationMs / 1000).toFixed(1)}s`);
if (readiness.summary.shortestBudgetMs !== null) {
  console.log(`  Tightest budget: ${(readiness.summary.shortestBudgetMs / 1000).toFixed(1)}s`);
}

console.log('\n  Per-POI breakdown:');
console.log(
  `  ${'POI'.padEnd(28)} ${'Stop#'.padEnd(6)} ${'Mem'.padEnd(4)} ${'PL wc'.padEnd(7)} ${'EN wc'.padEnd(7)} ${'PL dur'.padEnd(8)} ${'EN dur'.padEnd(8)} ${'Dist→'.padEnd(7)} ${'Budget'.padEnd(8)} Overlap`,
);
console.log('  ' + '─'.repeat(100));

for (const n of readiness.narratives) {
  const plLang = n.languages.find((l) => l.lang === 'pl');
  const enLang = n.languages.find((l) => l.lang === 'en');
  const mem = n.isMemorial ? '🕯️' : '  ';
  const plWc = plLang?.available ? String(plLang.wordCount) : 'MISS';
  const enWc = enLang?.available ? String(enLang.wordCount) : 'MISS';
  const plDur = plLang?.available ? `${(plLang.estimatedDurationMs / 1000).toFixed(1)}s` : '-';
  const enDur = enLang?.available ? `${(enLang.estimatedDurationMs / 1000).toFixed(1)}s` : '-';
  const dist = n.distToNextM !== null ? `${Math.round(n.distToNextM)}m` : '-';
  const budget =
    plLang?.timeBudgetMs !== null && plLang?.timeBudgetMs !== undefined
      ? `${(plLang.timeBudgetMs / 1000).toFixed(1)}s`
      : '-';
  const overlap = n.overlapRisk ? '⚠️ OVERLAP' : '✓';

  console.log(
    `  ${n.poiId.padEnd(28)} ${String(n.stopIndex).padEnd(6)} ${mem.padEnd(4)} ${plWc.padEnd(7)} ${enWc.padEnd(7)} ${plDur.padEnd(8)} ${enDur.padEnd(8)} ${dist.padEnd(7)} ${budget.padEnd(8)} ${overlap}`,
  );
}

if (readiness.overlapWarnings.length > 0) {
  console.log('\n  ⚠️  Overlap Warnings:');
  for (const w of readiness.overlapWarnings) {
    console.log(`    ${w}`);
  }
}

if (readiness.geofenceAnalysis.some((g) => g.overlapsNeighbor)) {
  console.log('\n  ⚠️  Geofence Overlap Analysis:');
  for (const g of readiness.geofenceAnalysis) {
    if (g.overlapsNeighbor) {
      console.log(
        `    ${g.poiId}: radius=${g.radiusM}m, nearest=${g.neighborId} at ${g.distToNearestNeighborM}m (OVERLAPS)`,
      );
    }
  }
}

// ─── Assertions ─────────────────────────────────────────────────────────────

console.log('\n\n── Assertions ─────────────────────────────────────────────────\n');

let exitCode = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    console.log(`  ✗ ${message}`);
    exitCode = 1;
  }
}

assert(
  reportPl.firedPois.length === WARSAW_180_NORTH_POIS.length,
  `All ${WARSAW_180_NORTH_POIS.length} POIs fired (got ${reportPl.firedPois.length})`,
);
assert(!reportPl.stuckPlaying, 'No segment stuck playing at end');
assert(reportPl.errors.length === 0, 'No errors during simulation');
assert(
  reportPl.finalPhase === 'Ended' || reportPl.finalPhase === 'Idle',
  `Final phase is Ended or Idle (got ${reportPl.finalPhase})`,
);
assert(new Set(reportPl.firedPois).size === reportPl.firedPois.length, 'No duplicate POI fires');
assert(
  readiness.summary.missingCount === 0,
  `No missing narratives (got ${readiness.summary.missingCount})`,
);
assert(
  readiness.orderAnomalies.length === 0,
  `No order anomalies (got ${readiness.orderAnomalies.length})`,
);

console.log('');

if (exitCode !== 0) {
  console.log('❌ SIMULATION FAILED — see assertions above.\n');
} else {
  console.log('✅ All assertions passed.\n');
}

process.exit(exitCode);
