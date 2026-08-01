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
      /** Resolved language for the segment. */
      language: string;
      /**
       * For source 'audio': absolute file URI of the verified pre-rendered asset.
       * For source 'tts': narrative locator (segment id or path), resolved by
       * the narrative resolver at the runtime layer.
       */
      assetPath: string;
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
