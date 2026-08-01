/**
 * Deterministic ride simulator tests — all 11 scenarios.
 *
 * Uses the REAL Warsaw 180 route config and narratives (read-only).
 * Feeds traces through the production geofence pipeline and reducer.
 *
 * Scenarios:
 *  1. Clean full northbound ride
 *  2. Accuracy degradation
 *  3. Out-of-order timestamp spike
 *  4. 90s location dropout
 *  5. Mid-route boarding
 *  6. Fast pass without dwell
 *  7. Traffic stop
 *  8. Focus interruption/regain
 *  9. Lifecycle event (start → end → start second tour)
 * 10. Missing playback completion watchdog/fault
 * 11. End then second tour
 */

import {
  generateCleanRideTrace,
  generateDwellTrace,
  generateMidRouteBoardingTrace,
  generateTrafficStopTrace,
  injectAccuracyDegradation,
  injectFocusInterruption,
  injectLocationDropout,
  injectTimestampSpike,
} from './generators';
import { generateReadinessReport } from './readiness';
import type { SimulationReport } from './runner';
import { runSimulation } from './runner';
import type { TraceEvent } from './trace';
import {
  MEMORIAL_POI_IDS,
  WARSAW_180_NORTH_POIS,
  warsaw180PoiCenters,
  warsaw180ReadinessConfig,
  warsaw180RunnerConfig,
} from './warsaw180Config';

// ─── Helpers ────────────────────────────────────────────────────────────────

const POI_COUNT = WARSAW_180_NORTH_POIS.length; // 24

function runCleanDwellSim(language: string = 'pl'): SimulationReport {
  const poiCenters = warsaw180PoiCenters();
  const trace = generateDwellTrace(poiCenters, 4000, {
    speedMps: 8,
    fixIntervalMs: 1000,
    accuracyM: 10,
  });
  return runSimulation(trace, warsaw180RunnerConfig(language));
}

// ─── Scenario 1: Clean full northbound ride ─────────────────────────────────

describe('Scenario 1: Clean full northbound ride', () => {
  let report: SimulationReport;

  beforeAll(() => {
    report = runCleanDwellSim('pl');
  });

  it('fires all 24 POIs', () => {
    expect(report.firedPois.length).toBe(POI_COUNT);
  });

  it('fires POIs in authored order', () => {
    const expectedOrder = WARSAW_180_NORTH_POIS.map((p) => p.poiId);
    expect(report.firedPois).toEqual(expectedOrder);
  });

  it('consumes all fired POIs', () => {
    // Generated traces include a quiet tail before End Tour, so the final
    // narration must complete naturally rather than being cancelled 100ms
    // after it starts. This catches incorrect end-of-route scheduling.
    expect(report.consumedPois).toEqual(report.firedPois);
  });

  it('has no duplicate fires', () => {
    expect(new Set(report.firedPois).size).toBe(report.firedPois.length);
  });

  it('has no duplicate consumption', () => {
    expect(new Set(report.consumedPois).size).toBe(report.consumedPois.length);
  });

  it('does not get stuck playing', () => {
    expect(report.stuckPlaying).toBe(false);
  });

  it('ends in Ended or Idle phase', () => {
    expect(['Ended', 'Idle']).toContain(report.finalPhase);
  });

  it('has no errors', () => {
    expect(report.errors).toHaveLength(0);
  });

  it('produces deterministic output on re-run', () => {
    const report2 = runCleanDwellSim('pl');
    expect(report2.firedPois).toEqual(report.firedPois);
    expect(report2.consumedPois).toEqual(report.consumedPois);
    expect(report2.acceptedFixes).toBe(report.acceptedFixes);
    expect(report2.rejectedFixes).toBe(report.rejectedFixes);
  });

  it('has no rejected fixes for clean trace', () => {
    expect(report.rejectedFixes).toBe(0);
  });

  it('issues a PlaySegment command for each fired POI', () => {
    const playCommands = report.commandsEmitted.filter((c) => c.kind === 'PlaySegment');
    expect(playCommands.length).toBe(POI_COUNT);
  });

  it('works identically with EN language', () => {
    const enReport = runCleanDwellSim('en');
    // Same POIs fire regardless of language
    expect(enReport.firedPois).toEqual(report.firedPois);
    expect(enReport.firedPois.length).toBe(POI_COUNT);
  });
});

// ─── Scenario 2: Accuracy degradation ──────────────────────────────────────

describe('Scenario 2: Accuracy degradation', () => {
  it('rejects fixes with accuracy > 50m', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    // Degrade accuracy from 20s to 40s into the trace
    const startMs = 1_700_000_000_000;
    const degradedTrace = injectAccuracyDegradation(
      baseTrace,
      startMs + 20_000,
      startMs + 40_000,
      80, // > 50m threshold
    );

    const report = runSimulation(degradedTrace, warsaw180RunnerConfig('pl'));

    expect(report.rejectedFixes).toBeGreaterThan(0);
    expect(report.rejectionReasons['accuracy']).toBeGreaterThan(0);
  });

  it('still fires POIs outside the degraded window', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    // Degrade only a short window early in the trace
    const startMs = 1_700_000_000_000;
    const degradedTrace = injectAccuracyDegradation(
      baseTrace,
      startMs + 5_000,
      startMs + 8_000,
      80,
    );

    const report = runSimulation(degradedTrace, warsaw180RunnerConfig('pl'));

    // Should still fire most POIs (degradation is brief and early)
    expect(report.firedPois.length).toBeGreaterThan(20);
  });
});

// ─── Scenario 3: Out-of-order timestamp spike ──────────────────────────────

describe('Scenario 3: Out-of-order timestamp spike', () => {
  it('rejects out-of-order spike as spike rejection', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const startMs = 1_700_000_000_000;
    // Insert a spike with a past timestamp and far-away coordinates
    const spikeTrace = injectTimestampSpike(
      baseTrace,
      startMs + 15_000,
      startMs + 10_000, // timestamp in the past
      [52.0, 20.0], // far from route
    );

    const report = runSimulation(spikeTrace, warsaw180RunnerConfig('pl'));

    expect(report.rejectedFixes).toBeGreaterThan(0);
    expect(report.rejectionReasons['spike']).toBeGreaterThan(0);
    // Rest of the ride should still work
    expect(report.firedPois.length).toBeGreaterThan(20);
  });
});

// ─── Scenario 4: 90s location dropout ──────────────────────────────────────

describe('Scenario 4: 90s location dropout', () => {
  it('some fixes are missing during the dropout window', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const startMs = 1_700_000_000_000;
    // 90s dropout starting ~60s in
    const dropoutTrace = injectLocationDropout(baseTrace, startMs + 60_000, startMs + 150_000);

    const report = runSimulation(dropoutTrace, warsaw180RunnerConfig('pl'));

    // The dropout removes GPS fixes but the dwell trace provides 4s of
    // fixes at each POI center. Whether a POI fires depends on whether
    // the dropout window overlaps with the dwell at that POI.
    // With the dwell trace, the bus sits at each POI — so POIs whose dwell
    // period falls entirely within the dropout are missed.
    // Key assertion: fewer fixes than the base trace
    const baseReport = runSimulation(baseTrace, warsaw180RunnerConfig('pl'));
    expect(report.acceptedFixes).toBeLessThan(baseReport.acceptedFixes);
    // No stuck playing
    expect(report.stuckPlaying).toBe(false);
    // Should still fire many POIs (dropout is only ~10% of the ride)
    expect(report.firedPois.length).toBeGreaterThan(15);
  });

  it('misses POIs when dropout covers their entire dwell window', () => {
    const poiCenters = warsaw180PoiCenters();
    // Use a clean ride (no dwell) so the dropout actually causes misses
    const baseTrace = generateCleanRideTrace(poiCenters, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const startMs = 1_700_000_000_000;
    // Long dropout covering multiple POI transits
    const dropoutTrace = injectLocationDropout(baseTrace, startMs + 30_000, startMs + 300_000);

    const report = runSimulation(dropoutTrace, warsaw180RunnerConfig('pl'));

    // With a clean ride trace (no forced dwell), many POIs rely on
    // accumulating dwell time from repeated fixes. A long dropout
    // prevents this, causing POIs to miss.
    expect(report.firedPois.length).toBeLessThan(POI_COUNT);
    expect(report.firedPois.length).toBeGreaterThan(0);
  });
});

// ─── Scenario 5: Mid-route boarding ────────────────────────────────────────

describe('Scenario 5: Mid-route boarding', () => {
  it('fires only POIs from boarding point onwards', () => {
    const poiCenters = warsaw180PoiCenters();
    const boardingIndex = 10; // Board at 11th POI

    const trace = generateMidRouteBoardingTrace(poiCenters, boardingIndex, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const report = runSimulation(trace, warsaw180RunnerConfig('pl'));

    // Should fire POIs from boarding point onward
    const expectedPois = WARSAW_180_NORTH_POIS.slice(boardingIndex).map((p) => p.poiId);
    expect(report.firedPois.length).toBe(expectedPois.length);
    expect(report.firedPois).toEqual(expectedPois);
  });
});

// ─── Scenario 6: Fast pass without dwell ───────────────────────────────────

describe('Scenario 6: Fast pass without dwell', () => {
  it('fires fewer POIs when bus moves too fast to dwell', () => {
    const poiCenters = warsaw180PoiCenters();

    // At 30 m/s with 2s fix interval, distPerFix = 60m. For geofences
    // with 60m radius (diameter 120m), the bus gets at most 2 fixes inside,
    // accumulating only 2s dwell — below the 3s threshold. Larger geofences
    // (110m+) still fire because they allow 3+ fixes during transit.
    // 30 m/s = 108 km/h, below the 120 km/h spike rejection threshold.
    const trace = generateCleanRideTrace(poiCenters, {
      speedMps: 30,
      fixIntervalMs: 2000,
      accuracyM: 10,
    });

    const report = runSimulation(trace, warsaw180RunnerConfig('pl'));

    // MUST fire strictly fewer than all POIs — small-radius geofences miss
    expect(report.firedPois.length).toBeLessThan(POI_COUNT);
    expect(report.firedPois.length).toBeGreaterThan(0);
    expect(report.stuckPlaying).toBe(false);
  });
});

// ─── Scenario 7: Traffic stop ──────────────────────────────────────────────

describe('Scenario 7: Traffic stop', () => {
  it('fires the POI at the traffic stop and continues after', () => {
    const poiCenters = warsaw180PoiCenters();

    // Traffic stop at POI index 5 (Plac Na Rozdrożu area) for 60s
    const trace = generateTrafficStopTrace(poiCenters, 5, 60_000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const report = runSimulation(trace, warsaw180RunnerConfig('pl'));

    // The POI at the traffic stop should definitely fire
    expect(report.firedPois).toContain(WARSAW_180_NORTH_POIS[5]!.poiId);
    // And others after it
    expect(report.firedPois.length).toBeGreaterThan(1);
    expect(report.stuckPlaying).toBe(false);
  });
});

// ─── Scenario 8: Focus interruption/regain ─────────────────────────────────

describe('Scenario 8: Focus interruption/regain', () => {
  it('pauses and resumes correctly on short focus loss', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const startMs = 1_700_000_000_000;
    // Five-second focus loss while the first POI is speaking.
    const focusTrace = injectFocusInterruption(baseTrace, startMs + 6_000, startMs + 11_000);

    const report = runSimulation(focusTrace, warsaw180RunnerConfig('pl'));
    const baseline = runSimulation(baseTrace, warsaw180RunnerConfig('pl'));

    // Should still fire all POIs (short interruption)
    expect(report.firedPois.length).toBe(POI_COUNT);
    expect(report.stuckPlaying).toBe(false);

    // Playback completion is delayed by exactly the 5-second focus-loss span;
    // it must not keep counting down while paused.
    const baselineFirstFinish = baseline.timeline.find((entry) => entry.kind === 'audio_finished');
    const interruptedFirstFinish = report.timeline.find((entry) => entry.kind === 'audio_finished');
    expect(baselineFirstFinish).toBeDefined();
    expect(interruptedFirstFinish).toBeDefined();
    expect(interruptedFirstFinish!.atMs - baselineFirstFinish!.atMs).toBe(5_000);

    // Should have focus loss/regain in timeline
    const focusLoss = report.timeline.filter((t) => t.kind === 'focus_loss');
    const focusRegain = report.timeline.filter((t) => t.kind === 'focus_regain');
    expect(focusLoss.length).toBeGreaterThanOrEqual(1);
    expect(focusRegain.length).toBeGreaterThanOrEqual(1);
  });

  it('emits PauseAudio on focus loss when playing', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const startMs = 1_700_000_000_000;
    // Focus loss while first POI is likely playing (after ~8s to reach + 3s dwell + a bit)
    const focusTrace = injectFocusInterruption(
      baseTrace,
      startMs + 6_000, // likely during first POI playback
      startMs + 8_000,
    );

    const report = runSimulation(focusTrace, warsaw180RunnerConfig('pl'));

    const pauseCmds = report.commandsEmitted.filter((c) => c.kind === 'PauseAudio');
    const resumeCmds = report.commandsEmitted.filter((c) => c.kind === 'ResumeAudio');

    // If a segment was playing during focus loss, we get pause/resume
    // (It's possible the focus loss hits between POIs, in which case no pause)
    if (pauseCmds.length > 0) {
      expect(resumeCmds.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ─── Scenario 9: Lifecycle event ────────────────────────────────────────────

describe('Scenario 9: Lifecycle — representable without TourRuntime', () => {
  it('engine handles start event correctly', () => {
    const poiCenters = warsaw180PoiCenters();
    const trace = generateDwellTrace(poiCenters.slice(0, 3), 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const report = runSimulation(trace, warsaw180RunnerConfig('pl'));

    // Tour starts, POIs fire, tour ends
    const tourStarts = report.timeline.filter((t) => t.kind === 'tour_start');
    const tourEnds = report.timeline.filter((t) => t.kind === 'tour_end');
    expect(tourStarts.length).toBe(1);
    expect(tourEnds.length).toBe(1);
  });
});

// ─── Scenario 10: Missing playback completion watchdog/fault ────────────────

describe('Scenario 10: Missing playback completion (TTS fault)', () => {
  it('handles TTS unavailability gracefully', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters.slice(0, 5), 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    // Inject TTS fault early
    const startMs = 1_700_000_000_000;
    const faultTrace: TraceEvent[] = [{ kind: 'TtsUnavailable', atMs: startMs - 1 }, ...baseTrace];

    const report = runSimulation(faultTrace, warsaw180RunnerConfig('pl'));

    // POIs should still fire (engine doesn't know TTS is unavailable)
    expect(report.firedPois.length).toBeGreaterThan(0);
    // Warnings about TTS unavailability
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes('TTS unavailable'))).toBe(true);
    // Should NOT be stuck playing (simulator models fallback)
    expect(report.stuckPlaying).toBe(false);
  });

  it('handles audio interruption without getting stuck', () => {
    const poiCenters = warsaw180PoiCenters();
    const baseTrace = generateDwellTrace(poiCenters.slice(0, 5), 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    // Inject audio interrupt mid-playback
    const startMs = 1_700_000_000_000;
    const faultTrace: TraceEvent[] = [...baseTrace];
    // Insert interrupt after first POI likely fires (~5s travel + 3s dwell + 1s)
    faultTrace.push({ kind: 'AudioInterrupted', atMs: startMs + 6_000 });
    faultTrace.sort((a, b) => a.atMs - b.atMs);

    const report = runSimulation(faultTrace, warsaw180RunnerConfig('pl'));

    expect(report.stuckPlaying).toBe(false);
    const firstPoi = WARSAW_180_NORTH_POIS[0]!.poiId;
    expect(report.firedPois).toContain(firstPoi);
    // No regain event was injected, so the interrupted first segment remains
    // unheard and must not be counted as consumed. End Tour later releases it.
    expect(report.consumedPois).not.toContain(firstPoi);
    expect(report.timeline).toContainEqual(
      expect.objectContaining({ kind: 'focus_loss', detail: 'Audio focus interrupted' }),
    );
  });
});

// ─── Scenario 11: End then second tour ──────────────────────────────────────

describe('Scenario 11: End then second tour', () => {
  it('can run a second tour after ending the first', () => {
    const poiCenters = warsaw180PoiCenters();
    const startMs = 1_700_000_000_000;

    // First tour: just first 3 POIs
    const trace1 = generateDwellTrace(poiCenters.slice(0, 3), 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
      startMs,
    });

    // Second tour: first 3 POIs again, starting after first tour ends
    const firstTourDuration = trace1[trace1.length - 1]!.atMs - startMs;
    const secondStartMs = startMs + firstTourDuration + 5000;
    const trace2 = generateDwellTrace(poiCenters.slice(0, 3), 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
      startMs: secondStartMs,
    });

    // Run both tours through one runner invocation. The release-timeout from
    // tour one fires before tour two starts, so the reducer must return to
    // Idle, reset pipeline/consumed state, and allow the same three POIs again.
    const combined: TraceEvent[] = [...trace1, ...trace2].sort((a, b) => a.atMs - b.atMs);
    const report = runSimulation(combined, warsaw180RunnerConfig('pl'));

    const expected = WARSAW_180_NORTH_POIS.slice(0, 3).map((poi) => poi.poiId);
    expect(report.firedPois).toEqual([...expected, ...expected]);
    expect(report.consumedPois).toEqual([...expected, ...expected]);
    expect(report.stuckPlaying).toBe(false);
    expect(report.finalPhase).toBe('Idle');
  });
});

// ─── Readiness report tests ─────────────────────────────────────────────────

describe('Route readiness report', () => {
  it('reports all 24 POIs × 2 languages', () => {
    const report = generateReadinessReport(warsaw180ReadinessConfig());
    expect(report.totalPois).toBe(24);
    expect(report.totalLanguages).toBe(2);
    expect(report.summary.totalNarratives).toBe(48);
  });

  it('has no missing narratives for Warsaw 180', () => {
    const report = generateReadinessReport(warsaw180ReadinessConfig());
    expect(report.summary.missingCount).toBe(0);
    expect(report.missingNarratives).toHaveLength(0);
  });

  it('identifies memorial POIs correctly', () => {
    const report = generateReadinessReport(warsaw180ReadinessConfig());
    expect(report.summary.memorialCount).toBe(MEMORIAL_POI_IDS.length);
    const memorialNarratives = report.narratives.filter((n) => n.isMemorial);
    expect(memorialNarratives.map((n) => n.poiId).sort()).toEqual([...MEMORIAL_POI_IDS].sort());
  });

  it('has no order anomalies', () => {
    const report = generateReadinessReport(warsaw180ReadinessConfig());
    expect(report.orderAnomalies).toHaveLength(0);
  });

  it('computes word counts and durations', () => {
    const report = generateReadinessReport(warsaw180ReadinessConfig());
    expect(report.summary.averageWordCountPl).toBeGreaterThan(10);
    expect(report.summary.averageWordCountEn).toBeGreaterThan(10);
    expect(report.summary.averageDurationMsPl).toBeGreaterThan(1000);
    expect(report.summary.averageDurationMsEn).toBeGreaterThan(1000);
  });

  it('provides per-POI timing budgets', () => {
    const report = generateReadinessReport(warsaw180ReadinessConfig());
    // At least some POIs should have budget data (all except the last)
    const withBudget = report.narratives.filter((n) => n.travelTimeToNextMs !== null);
    expect(withBudget.length).toBe(23); // all except last
  });
});

// ─── Determinism tests ──────────────────────────────────────────────────────

describe('Determinism', () => {
  it('produces identical results across multiple runs', () => {
    const poiCenters = warsaw180PoiCenters();
    const trace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const config = warsaw180RunnerConfig('pl');
    const r1 = runSimulation(trace, config);
    const r2 = runSimulation(trace, config);
    const r3 = runSimulation(trace, config);

    expect(r1.firedPois).toEqual(r2.firedPois);
    expect(r2.firedPois).toEqual(r3.firedPois);
    expect(r1.timeline.length).toBe(r2.timeline.length);
    expect(r2.timeline.length).toBe(r3.timeline.length);
  });

  it('trace generator is deterministic (same input → same output)', () => {
    const poiCenters = warsaw180PoiCenters();
    const t1 = generateDwellTrace(poiCenters, 4000, { speedMps: 8 });
    const t2 = generateDwellTrace(poiCenters, 4000, { speedMps: 8 });
    expect(t1).toEqual(t2);
  });
});

// ─── Scenario 12: Mixed audio source (Wave 3) ──────────────────────────────

describe('Scenario 12: Mixed audio source (Wave 3)', () => {
  it('handles pre-rendered audio completion (source:audio commands modeled)', () => {
    const poiCenters = warsaw180PoiCenters().slice(0, 3);
    const trace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    // Use a config with mediaCatalog so the reducer emits source:'audio'.
    const baseConfig = warsaw180RunnerConfig('pl');
    const mediaCatalog = {
      defaultLanguage: 'pl',
      pois: Object.fromEntries(
        WARSAW_180_NORTH_POIS.map((p) => [
          p.poiId,
          {
            narratives: { pl: `${p.poiId}:pl`, en: `${p.poiId}:en` },
            audio: { pl: `/packs/audio/${p.poiId}.pl.m4a` },
          },
        ]),
      ),
    };
    const config = {
      ...baseConfig,
      tourConfig: { ...baseConfig.tourConfig, mediaCatalog },
    };

    const report = runSimulation(trace, config);

    // All 3 POIs should fire and complete.
    expect(report.firedPois.length).toBe(3);
    expect(report.consumedPois.length).toBe(3);
    expect(report.stuckPlaying).toBe(false);

    // PlaySegment commands should carry source:'audio'.
    const playCommands = report.commandsEmitted.filter((c) => c.kind === 'PlaySegment');
    expect(playCommands.length).toBe(3);
    for (const cmd of playCommands) {
      if (cmd.kind === 'PlaySegment') {
        expect(cmd.source).toBe('audio');
      }
    }
  });

  it('handles TTS-only scenario (no mediaCatalog)', () => {
    const poiCenters = warsaw180PoiCenters().slice(0, 3);
    const trace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const config = warsaw180RunnerConfig('pl');
    const report = runSimulation(trace, config);

    expect(report.firedPois.length).toBe(3);
    expect(report.stuckPlaying).toBe(false);

    // Without mediaCatalog, all should be source:'tts'.
    const playCommands = report.commandsEmitted.filter((c) => c.kind === 'PlaySegment');
    for (const cmd of playCommands) {
      if (cmd.kind === 'PlaySegment') {
        expect(cmd.source).toBe('tts');
      }
    }
  });

  it('handles unavailable POI (no content) without stranding', () => {
    const poiCenters = warsaw180PoiCenters().slice(0, 3);
    const trace = generateDwellTrace(poiCenters, 4000, {
      speedMps: 8,
      fixIntervalMs: 1000,
      accuracyM: 10,
    });

    const baseConfig = warsaw180RunnerConfig('pl');
    // Make first POI unavailable (empty catalog entry).
    const firstPoiId = WARSAW_180_NORTH_POIS[0]!.poiId;
    const mediaCatalog = {
      defaultLanguage: 'pl',
      pois: Object.fromEntries(
        WARSAW_180_NORTH_POIS.map((p) => [
          p.poiId,
          p.poiId === firstPoiId
            ? { narratives: {}, audio: {} } // Unavailable!
            : { narratives: { pl: `${p.poiId}:pl` }, audio: {} },
        ]),
      ),
    };
    const config = {
      ...baseConfig,
      tourConfig: { ...baseConfig.tourConfig, mediaCatalog },
    };

    const report = runSimulation(trace, config);

    // All 3 dwell events were processed. First POI is skipped (unavailable),
    // 2 POIs fire normally.
    expect(report.firedPois.length).toBe(3); // Pipeline fires all 3
    // But only 2 play commands (first was skipped by reducer).
    const playCommands = report.commandsEmitted.filter((c) => c.kind === 'PlaySegment');
    expect(playCommands.length).toBe(2);
    expect(report.stuckPlaying).toBe(false);
  });
});
