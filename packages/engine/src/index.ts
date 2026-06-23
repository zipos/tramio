// @tramio/engine
//
// Pure Tour_Engine reducer over EngineEvent / EngineCommand. Reducer
// implementation lands in tasks 3.2+. This barrel re-exports the
// runtime types defined in task 3.1.

export type {
  AcceptedUpdate,
  Entitlement,
  EntitlementTier,
  Geofence,
  LatLng,
  LocationMode,
  PositionUpdate,
} from './types';

export type { EngineEvent } from './events';
export type { EngineCommand } from './commands';

export type {
  ActiveState,
  BundleRef,
  DeadReckoningState,
  DeviationState,
  EndedState,
  IdleState,
  PlayingSegment,
  StandbyState,
  TourSession,
  TourState,
} from './state';

export {
  MAX_ACCURACY_M,
  MAX_SPEED_MPS,
  SMOOTH_WINDOW,
  angularDiffDeg,
  bearingDeg,
  haversine,
  initialPipelineState,
  isRejected,
  pointInCircle,
  pointInPolygon,
  prefilter,
  projectOnRoute,
  step,
} from './pipeline';
export type {
  DwellEntry,
  PipelineAccepted,
  PipelineOutput,
  PipelineRejected,
  PipelineState,
  PrefilterReject,
  RouteProjection,
} from './pipeline';

export { INITIAL_STATE, reduce } from './reducer';
export type { ReducerResult, StartTourConfig } from './reducer';

export { comparePriority, resolveOverlappingTriggers } from './priority';
export type { PriorityResolution } from './priority';

export { selectAudioSource } from './audioSource';
export type { AudioSourceResult } from './audioSource';
