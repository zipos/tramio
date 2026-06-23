// EngineEvent discriminated union.
//
// Verbatim from .kiro/specs/urban-narrative-mvp/design.md "Data Models >
// Runtime types (TypeScript)". This is the only input alphabet to the
// Tour_Engine reducer.
//
// @see Requirements 1.1, 5.5, 13.2, 14.2, 15.1

import type { AcceptedUpdate, Entitlement, PositionUpdate } from './types';

export type EngineEvent =
  | { kind: 'LocationAccepted'; update: AcceptedUpdate }
  | { kind: 'LocationRejected'; reason: 'accuracy' | 'spike' | 'duplicate'; update: PositionUpdate }
  | { kind: 'Timer'; id: string; firedAt: number }
  | { kind: 'EntitlementsChanged'; entitlements: Entitlement[] }
  | { kind: 'UserCommand'; cmd: 'start' | 'end' | 'resume-route' | 'switch-route' | 'dismiss' }
  | { kind: 'AudioFinished'; segmentId: string }
  | { kind: 'FocusLoss' }
  | { kind: 'FocusRegain' }
  | { kind: 'GeofenceEnter'; poiId: string }
  | { kind: 'GeofenceDwell'; poiId: string }
  | { kind: 'GeofenceExit'; poiId: string };
