# @tramio/native

TypeScript specs and command translators for the native turbo modules
(`Location_Service`, `Audio_Service`, `TTS_Engine`). Translates `EngineCommand`s
to native calls and forwards native events back as `EngineEvent`s.

Native iOS/Android sources live under the consuming app's `ios/` and `android/`
projects; this package owns only the JS-side surface.

Module boundary set up in task 1.3. Implementation tracked under tasks 8.1–8.7.
