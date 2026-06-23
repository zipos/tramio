// Type-only sanity tests for the runtime types defined in task 3.1.
//
// This file is verified by `tsc --noEmit` (workspace-root strict config)
// rather than executed by Jest. The `.spec-d.ts` suffix follows the
// dtslint / tsd convention so it is excluded from the Jest test glob
// (`*.test.ts`) but still picked up by the project's `include` globs.
//
// Every exported type from `@tramio/engine` is assigned at least one
// concrete inhabitant. Discriminated unions are exercised with one
// representative per `kind` so that any drift from the design.md
// definitions surfaces as a compile error.

import type {
  AcceptedUpdate,
  EngineCommand,
  EngineEvent,
  Entitlement,
  EntitlementTier,
  Geofence,
  LatLng,
  LocationMode,
  PositionUpdate,
  TourState,
} from '../index';

// ---------- primitives ----------

const _latLng: LatLng = [51.11, 17.03];

const _circleGeofence: Geofence = {
  poiId: 'poi-rynek',
  geometry: { kind: 'circle', center: _latLng, radiusMeters: 60 },
  directionFilter: { kind: 'alongRoute', toleranceDeg: 30 },
  dwellSec: 3,
  priority: 90,
  authorIndex: 0,
};

const _polygonGeofence: Geofence = {
  poiId: 'poi-park',
  geometry: {
    kind: 'polygon',
    vertices: [
      [51.11, 17.03],
      [51.111, 17.032],
      [51.112, 17.033],
    ],
  },
  dwellSec: 5,
  priority: 50,
  authorIndex: 1,
};

const _positionUpdate: PositionUpdate = {
  ts: 1_735_689_600_000,
  coord: _latLng,
  accuracyM: 12,
  speedMps: 4.2,
  headingDeg: 90,
};

const _acceptedUpdate: AcceptedUpdate = {
  ..._positionUpdate,
  smoothed: _latLng,
  alongRouteM: 1234.5,
};

const _tier: EntitlementTier = 'time_pass';

const _entitlement: Entitlement = {
  tier: _tier,
  scope: { bundleId: 'wroclaw-tram-7-east' },
  expiryUtc: 1_736_899_200_000,
};

const _modes: ReadonlyArray<LocationMode> = [
  'idle',
  'standby',
  'tour-bg',
  'tour-approach',
  'reconcile',
];

// ---------- EngineEvent: one inhabitant per `kind` ----------

const _events: ReadonlyArray<EngineEvent> = [
  { kind: 'LocationAccepted', update: _acceptedUpdate },
  { kind: 'LocationRejected', reason: 'accuracy', update: _positionUpdate },
  { kind: 'LocationRejected', reason: 'spike', update: _positionUpdate },
  { kind: 'LocationRejected', reason: 'duplicate', update: _positionUpdate },
  { kind: 'Timer', id: 'dr-entry', firedAt: 1_735_689_615_000 },
  { kind: 'EntitlementsChanged', entitlements: [_entitlement] },
  { kind: 'UserCommand', cmd: 'start' },
  { kind: 'UserCommand', cmd: 'end' },
  { kind: 'UserCommand', cmd: 'resume-route' },
  { kind: 'UserCommand', cmd: 'switch-route' },
  { kind: 'UserCommand', cmd: 'dismiss' },
  { kind: 'AudioFinished', segmentId: 'seg-poi-rynek-pl' },
  { kind: 'FocusLoss' },
  { kind: 'FocusRegain' },
  { kind: 'GeofenceEnter', poiId: 'poi-rynek' },
  { kind: 'GeofenceDwell', poiId: 'poi-rynek' },
  { kind: 'GeofenceExit', poiId: 'poi-rynek' },
];

// ---------- EngineCommand: one inhabitant per `kind` ----------

const _commands: ReadonlyArray<EngineCommand> = [
  {
    kind: 'PlaySegment',
    segmentId: 'seg-poi-rynek-pl',
    source: 'audio',
    preroll: { kind: 'disclosure', text: 'Sponsored by Cafe Zamek.' },
  },
  { kind: 'PlaySegment', segmentId: 'seg-poi-rynek-pl', source: 'tts' },
  {
    kind: 'RequestDecryptedSegment',
    segmentId: 'seg-poi-rynek-pl',
    bundleId: 'wroclaw-tram-7-east',
    bundleVersion: '1.4.2',
    encAssetPath: 'audio/poi-rynek.pl.m4a.enc',
  },
  { kind: 'StopAudio' },
  { kind: 'PauseAudio' },
  { kind: 'ResumeAudio', offsetMs: 1234 },
  { kind: 'RequestLocationMode', mode: 'tour-approach' },
  { kind: 'ScheduleTimer', id: 'dr-entry', afterMs: 15_000 },
  { kind: 'CancelTimer', id: 'dr-entry' },
  { kind: 'ShowDeviationPrompt' },
  { kind: 'HideDeviationPrompt' },
  { kind: 'ReleaseAll' },
];

// ---------- TourState: one inhabitant per phase ----------

const _idle: TourState = { phase: 'Idle' };

const _activeSession = {
  bundle: { bundleId: 'wroclaw-tram-7-east', bundleVersion: '1.4.2' },
  geofences: [_circleGeofence] as ReadonlyArray<Geofence>,
  consumed: new Set<string>() as ReadonlySet<string>,
  playing: {
    segmentId: 'seg-poi-rynek-pl',
    poiId: 'poi-rynek',
    startedAtMs: 1_735_689_700_000,
  },
  lastAccepted: _acceptedUpdate,
  entitlements: [_entitlement] as ReadonlyArray<Entitlement>,
  deviationPending: false,
  currentLanguage: 'pl',
  drDisabled: false,
} as const;

const _active: TourState = { phase: 'Active', session: _activeSession };

const _standby: TourState = {
  phase: 'Standby',
  session: _activeSession,
  standbyTrackId: 'trivia-architecture',
};

const _deadReckoning: TourState = {
  phase: 'DeadReckoning',
  session: _activeSession,
  enteredAtMs: 1_735_689_715_000,
};

const _deviation: TourState = {
  phase: 'Deviation',
  session: { ..._activeSession, deviationPending: true },
  detectedAtMs: 1_735_689_775_000,
  promptVisible: true,
};

const _ended: TourState = { phase: 'Ended', endedAtMs: 1_735_689_900_000 };

// Exhaustiveness check: every TourState phase must be representable.
function _exhaustivePhase(s: TourState): string {
  switch (s.phase) {
    case 'Idle':
      return 'idle';
    case 'Active':
      return 'active';
    case 'Standby':
      return 'standby';
    case 'DeadReckoning':
      return 'dr';
    case 'Deviation':
      return 'deviation';
    case 'Ended':
      return 'ended';
    default: {
      const _never: never = s;
      return _never;
    }
  }
}

// Touch every binding so unused-locals linting (if enabled) does not strip
// the assertions away.
export const __typeSanity = {
  _latLng,
  _circleGeofence,
  _polygonGeofence,
  _positionUpdate,
  _acceptedUpdate,
  _tier,
  _entitlement,
  _modes,
  _events,
  _commands,
  _idle,
  _active,
  _standby,
  _deadReckoning,
  _deviation,
  _ended,
  _exhaustivePhase,
};
