/**
 * @tramio/simulator — Deterministic ride simulator for Tramio.
 *
 * Feeds real GPS traces through the production geofence pipeline and
 * Tour_Engine reducer for offline route testing and authoring-readiness
 * reports. No network, no native modules, no I/O — pure deterministic
 * execution.
 *
 * @example
 * ```ts
 * import { generateDwellTrace, runSimulation, warsaw180RunnerConfig, warsaw180PoiCenters } from '@tramio/simulator';
 *
 * const trace = generateDwellTrace(warsaw180PoiCenters(), 4000);
 * const report = runSimulation(trace, warsaw180RunnerConfig('pl'));
 * console.log(report.firedPois.length); // 24
 * ```
 *
 * @module
 */

export type {
  TraceEvent,
  GpsFixEvent,
  AppBackgroundEvent,
  AppForegroundEvent,
  UserCommandEvent,
  TtsUnavailableEvent,
  TtsAvailableEvent,
  AudioInterruptedEvent,
} from './trace';

export {
  generateCleanRideTrace,
  generateDwellTrace,
  generateFastPassTrace,
  generateMidRouteBoardingTrace,
  generateTrafficStopTrace,
  injectAccuracyDegradation,
  injectFocusInterruption,
  injectLocationDropout,
  injectTimestampSpike,
} from './generators';
export type { TraceGeneratorOptions } from './generators';

export { runSimulation, computeNarrationDurationMs } from './runner';
export type {
  NarrativeMeta,
  RunnerConfig,
  SimulationReport,
  TimelineEntry,
  TriggerDetail,
} from './runner';

export { generateReadinessReport } from './readiness';
export type {
  GeofenceAnalysis,
  LanguageReadiness,
  NarrativeReadiness,
  PoiInfo,
  ReadinessConfig,
  ReadinessSummary,
  RouteReadinessReport,
} from './readiness';

export {
  warsaw180RunnerConfig,
  warsaw180ReadinessConfig,
  warsaw180PoiCenters,
  warsaw180AllNarratives,
  WARSAW_180_NORTH_GEOFENCES,
  WARSAW_180_NORTH_POIS,
  WARSAW_180_NORTH_ROUTE,
  WARSAW_180_NORTH_STOPS,
  WARSAW_180_NORTH_TOUR_CONFIG,
  MEMORIAL_POI_IDS,
} from './warsaw180Config';
