//
//  TramioLocationService.h
//  @tramio/native — Location_Service iOS native side (task 8.1)
//
//  Wraps `CLLocationManager` (Req 11.1, 11.2, 11.3, 11.4, 12.2, 12.3,
//  15.1) and exposes the JS-side spec declared in
//  `packages/native/src/location/NativeLocationService.ts`.
//
//  The module owns three responsibilities that intentionally stay
//  native (rather than living in JS) because they need to be cheap on
//  battery and resilient to JS-thread suspension while the screen is
//  locked:
//
//    1. Stage 1 of the geofence pipeline: the **accuracy gate**. Every
//       `CLLocation` whose `horizontalAccuracy` exceeds 50 m is dropped
//       at the bridge boundary and surfaced as an `onRejected` event
//       with `reason="accuracy"` (Req 5.1).
//
//    2. Stage 2 of the geofence pipeline: **spike rejection**. We
//       compare the great-circle distance between consecutive accepted
//       fixes and reject any update whose implied ground speed exceeds
//       120 km/h (33.33 m/s) — this is what turns a one-frame GPS
//       glitch in a tunnel mouth into an `onRejected` with
//       `reason="spike"` instead of a 200 m position jump (Req 5.2).
//
//    3. The **sliding region window**. iOS caps active region monitors
//       at 20 (`CLLocationManager.maximumRegionMonitoringDistance` and
//       the documented per-app limit). For long routes with many POIs,
//       the JS layer hands us the full geofence list via
//       `armGeofences`, and we re-arm the 18 nearest regions (a
//       headroom of two slots is left for transient
//       reconciliation regions per design.md "iOS region monitoring
//       limited to 20 active regions"). The window slides on every
//       accepted update.
//
//  Operational modes are translated by `setMode:` into the
//  `CLLocationManager` configuration that satisfies the design's
//  Battery and Polling Policy table:
//
//    idle           : stop everything; keep significant-location-changes
//                     monitoring off.
//    standby        : significant-location-changes only; high-accuracy
//                     fixes are not requested.
//    tour-bg        : region monitoring + significant-location-changes.
//    tour-approach  : `desiredAccuracy = kCLLocationAccuracyBest` for
//                     the duration of the approach window.
//    reconcile      : same as tour-approach until two clean fixes are
//                     received post-DR (Req 6.4, 11.3).
//
//  The user-visible high-accuracy indicator (Req 11.5) is driven by
//  `onAccuracyChanged` which fires whenever the module enters/leaves
//  `tour-approach` or `reconcile`.
//

#import <Foundation/Foundation.h>
#import <React/RCTEventEmitter.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/// Event names emitted via `RCTEventEmitter`. They match the JS-side
/// `NATIVE_LOCATION_EVENT_NAMES` array verbatim.
extern NSString *const kTramioLocationEventAccepted;
extern NSString *const kTramioLocationEventRejected;
extern NSString *const kTramioLocationEventGeofenceEnter;
extern NSString *const kTramioLocationEventGeofenceDwell;
extern NSString *const kTramioLocationEventGeofenceExit;
extern NSString *const kTramioLocationEventAccuracyChanged;

/// Operational mode strings accepted by `setMode:`. Mirrors
/// `NativeLocationMode` on the JS side.
extern NSString *const kTramioLocationModeIdle;
extern NSString *const kTramioLocationModeStandby;
extern NSString *const kTramioLocationModeTourBg;
extern NSString *const kTramioLocationModeTourApproach;
extern NSString *const kTramioLocationModeReconcile;

/// Hard limits enforced by the native pipeline. Exposed in the header
/// so tests (Swift / Obj-C XCTest, task 8.7) can reference the same
/// constants the production code uses.
extern const double kTramioLocationMaxAccuracyMeters;        // 50
extern const double kTramioLocationMaxGroundSpeedMps;        // 33.33  (120 km/h)
extern const NSUInteger kTramioLocationRegionWindowSize;     // 18
extern const NSUInteger kTramioLocationOsRegionLimit;        // 20

@interface TramioLocationService : RCTEventEmitter <RCTBridgeModule>
@end

NS_ASSUME_NONNULL_END
