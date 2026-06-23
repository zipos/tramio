// Geofence filtering pipeline barrel.
//
// @see design.md "## Geofence Filtering Pipeline"

export {
  angularDiffDeg,
  bearingDeg,
  haversine,
  pointInCircle,
  pointInPolygon,
  projectOnRoute,
} from './geo';
export type { RouteProjection } from './geo';

export {
  MAX_ACCURACY_M,
  MAX_SPEED_MPS,
  SMOOTH_WINDOW,
  initialPipelineState,
  isRejected,
  prefilter,
  step,
} from './pipeline';
export type {
  DwellEntry,
  PipelineAccepted,
  PipelineOutput,
  PipelineRejected,
  PipelineState,
  PrefilterReject,
} from './pipeline';
