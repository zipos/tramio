// @tramio/native
//
// TypeScript specs and command translators for native turbo modules:
// Location_Service, Audio_Service, TTS_Engine. Native iOS sources live
// under `packages/native/ios/` and are wired into the consuming app's
// xcodeproj when `expo prebuild` runs (we use Expo bare). Android sources
// land in task 8.2.

export * as Location from './location';
