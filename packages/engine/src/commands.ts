// EngineCommand discriminated union.
//
// Verbatim from .kiro/specs/urban-narrative-mvp/design.md "Data Models >
// Runtime types (TypeScript)". The reducer's only outputs are values of
// this type; command translators (Audio_Service, Location_Service,
// TTS_Engine, UI host) are responsible for executing them and feeding
// resulting native events back as `EngineEvent`s.
//
// @see Requirements 1.1, 5.5, 13.2, 14.2, 15.1

import type { LocationMode } from './types';

export type EngineCommand =
  | {
      kind: 'PlaySegment';
      segmentId: string;
      source: 'audio' | 'tts';
      preroll?: { kind: 'disclosure'; text: string };
    }
  | {
      kind: 'RequestDecryptedSegment';
      segmentId: string;
      bundleId: string;
      bundleVersion: string;
      encAssetPath: string;
    }
  | { kind: 'StopAudio' }
  | { kind: 'PauseAudio' }
  | { kind: 'ResumeAudio'; offsetMs: number }
  | { kind: 'RequestLocationMode'; mode: LocationMode }
  | { kind: 'ScheduleTimer'; id: string; afterMs: number }
  | { kind: 'CancelTimer'; id: string }
  | { kind: 'ShowDeviationPrompt' }
  | { kind: 'HideDeviationPrompt' }
  | { kind: 'ReleaseAll' };
