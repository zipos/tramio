// Public Audio_Service surface.
//
// Exports the typed wrapper plus the supporting types. The raw turbo
// module spec (`NativeAudioService.ts`) and the test fake
// (`FakeAudioBridge.ts`) are NOT re-exported from the package barrel:
// production consumers go through `AudioService`, and tests import the
// fake directly with a relative path.

export { AudioService } from './AudioService';
export type {
  AudioServiceEvent,
  AudioServiceEventKind,
  AudioServiceListener,
  AudioSource,
  DecryptStreamHandle,
  DuckingChangeEvent,
  FocusLossEvent,
  FocusRegainEvent,
  PlayOptions,
  PlaybackFinishedEvent,
  PlaybackFinishReason,
  Unsubscribe,
} from './types';
export {
  DUCK_ACTIVE_THRESHOLD_PERCENT,
  DUCK_PERCENT_MAX,
  DUCK_PERCENT_MIN,
  GAIN_OFFSET_DB_MAX,
  GAIN_OFFSET_DB_MIN,
} from './NativeAudioService';
export type { Spec as NativeAudioServiceSpec } from './NativeAudioService';
