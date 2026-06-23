// @tramio/native — TTS_Engine subtree barrel
//
// Exports the JS-side TTS_Engine spec (task 8.5). The native iOS binding
// lives at `packages/native/ios/Tts/`. Android side is task 8.6.

export type {
  FocusLossListener,
  FocusRegainListener,
  LanguageTag,
  NativeTtsEngineBinding,
  PlaybackFinishedListener,
  RegionTag,
  SpeakOptions,
  TtsPlaybackEvent,
  TtsPlaybackListener,
  Unsubscribe,
} from './types';

export type { NativeTtsEngine } from './NativeTtsEngine';
export { createNativeTtsEngine } from './NativeTtsEngine';

export type {
  ResolveStep,
  ResolveVoiceInput,
  ResolveVoiceResult,
  ResolveVoiceWarning,
  VoiceDescriptor,
  WarningSink,
} from './resolveVoice';
export { noopWarningSink, resolveVoice } from './resolveVoice';
