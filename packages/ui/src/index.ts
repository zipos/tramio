// @tramio/ui
//
// React Native UI surfaces: route selection, tour playback, wiring layer.

export { TourRuntime } from './wiring/TourRuntime';
export type { StateListener } from './wiring/TourRuntime';
export { useTourEngine } from './wiring/useTourEngine';
export type { UseTourEngineResult } from './wiring/useTourEngine';
export { RouteSelectionScreen } from './screens/RouteSelectionScreen';
export type { RouteSelectionScreenProps } from './screens/RouteSelectionScreen';
export { TourPlaybackScreen } from './screens/TourPlaybackScreen';
export type { TourPlaybackScreenProps } from './screens/TourPlaybackScreen';
export { ErrorBoundary } from './components/ErrorBoundary';
export type { ErrorBoundaryProps } from './components/ErrorBoundary';
export { NextPoiIndicator } from './components/NextPoiIndicator';
export type { NextPoiIndicatorProps } from './components/NextPoiIndicator';
export { BackgroundBanner } from './components/BackgroundBanner';
export type { BackgroundBannerProps } from './components/BackgroundBanner';
export { MidRouteBoardingNotice } from './components/MidRouteBoardingNotice';
export type { MidRouteBoardingNoticeProps } from './components/MidRouteBoardingNotice';
export { GpsDeliveryBanner } from './components/GpsDeliveryBanner';
export type { GpsDeliveryBannerProps } from './components/GpsDeliveryBanner';
export { FieldDiagnosticsRecorder, bucketAccuracy } from './wiring/fieldDiagnostics';
export type {
  AccuracyBucket,
  RejectionCategory,
  LifecycleTransition,
  DeliveryStatusEvent,
  FieldDiagnosticsReport,
  DiagnosticsCounters,
  DiagnosticsClock,
} from './wiring/fieldDiagnostics';
export type { LocationDeliveryStatus } from './wiring/TourRuntime';
