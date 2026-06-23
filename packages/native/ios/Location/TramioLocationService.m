//
//  TramioLocationService.m
//  @tramio/native — Location_Service iOS native side (task 8.1)
//
//  Implementation notes:
//
//  - All `CLLocationManager` interactions happen on the main thread.
//    `methodQueue` returns the main queue so React Native's bridge
//    serializes calls against it; the manager's delegate callbacks
//    arrive on whichever queue we hand to `[CLLocationManager
//    setDelegate:]`, which the documentation pins to the queue
//    `CLLocationManager` was constructed on. We construct on main.
//
//  - The JS-side spec passes geofences as `NSDictionary` objects with
//    a discriminated `geometry` field (`circle` or `polygon`). iOS only
//    natively supports circular regions for `CLCircularRegion`, so
//    polygon geofences are converted to a circumscribing circle for the
//    OS-level region monitor; the JS-side `step 4 dwell` path
//    (`smoothed ∈ geometry`) re-checks the precise polygon containment
//    so this approximation does not produce false positives.
//
//  - Sliding region window: we keep a sorted list of all geofences
//    armed by the JS layer in `_allGeofences` and re-arm the 18 nearest
//    on every accepted update via `_rearmRegionsForLocation:`. The
//    `_armedPoiIds` set tracks which subset is currently registered
//    with `startMonitoringForRegion:` so `_rearmRegionsForLocation:`
//    can compute symmetric diffs without re-issuing identical calls.
//
//  - Spike rejection compares against `_lastAcceptedLocation` whose
//    timestamp comes from `CLLocation.timestamp` (CoreLocation supplies
//    this; we never use wall-clock to defend against device-time skew
//    while in airplane mode).
//

#import "TramioLocationService.h"
#import <CoreLocation/CoreLocation.h>
#import <os/log.h>

NSString *const kTramioLocationEventAccepted        = @"onAccepted";
NSString *const kTramioLocationEventRejected        = @"onRejected";
NSString *const kTramioLocationEventGeofenceEnter   = @"onGeofenceEnter";
NSString *const kTramioLocationEventGeofenceDwell   = @"onGeofenceDwell";
NSString *const kTramioLocationEventGeofenceExit    = @"onGeofenceExit";
NSString *const kTramioLocationEventAccuracyChanged = @"onAccuracyChanged";

NSString *const kTramioLocationModeIdle          = @"idle";
NSString *const kTramioLocationModeStandby       = @"standby";
NSString *const kTramioLocationModeTourBg        = @"tour-bg";
NSString *const kTramioLocationModeTourApproach  = @"tour-approach";
NSString *const kTramioLocationModeReconcile     = @"reconcile";

const double kTramioLocationMaxAccuracyMeters       = 50.0;
const double kTramioLocationMaxGroundSpeedMps       = 33.33; // 120 km/h
const NSUInteger kTramioLocationRegionWindowSize    = 18;
const NSUInteger kTramioLocationOsRegionLimit       = 20;

static os_log_t TramioLocationLog(void) {
  static os_log_t log;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    log = os_log_create("app.tramio.client", "LocationService");
  });
  return log;
}

#pragma mark - Geofence model

/// Internal geofence representation. We convert polygons to a
/// circumscribing circle for OS-level region monitoring; the JS-side
/// dwell stage re-checks precise containment.
@interface TramioGeofenceEntry : NSObject
@property (nonatomic, copy)   NSString *poiId;
@property (nonatomic, assign) CLLocationCoordinate2D center;
@property (nonatomic, assign) CLLocationDistance radiusMeters;
@property (nonatomic, assign) NSTimeInterval dwellSec;
@end

@implementation TramioGeofenceEntry
@end

static double SquaredDistanceMeters(CLLocationCoordinate2D a, CLLocationCoordinate2D b) {
  // Equirectangular approximation. Sufficient for the "nearest 18"
  // ranking; the exact distance does not matter, only the relative
  // ordering, and over a single tour the lat range is small.
  static const double kMetersPerDegLat = 111320.0;
  double dLat = (a.latitude - b.latitude) * kMetersPerDegLat;
  double meanLatRad = ((a.latitude + b.latitude) / 2.0) * (M_PI / 180.0);
  double dLon = (a.longitude - b.longitude) * kMetersPerDegLat * cos(meanLatRad);
  return dLat * dLat + dLon * dLon;
}

#pragma mark - Module

@interface TramioLocationService () <CLLocationManagerDelegate>
@property (nonatomic, strong) CLLocationManager *manager;
@property (nonatomic, copy)   NSString *currentMode;
@property (nonatomic, assign) BOOL hasJSListeners;
@property (nonatomic, strong, nullable) CLLocation *lastAcceptedLocation;
@property (nonatomic, assign) BOOL highAccuracyActive;

/// Full geofence set as armed by JS. Sorted lazily inside
/// `_rearmRegionsForLocation:`.
@property (nonatomic, strong) NSMutableArray<TramioGeofenceEntry *> *allGeofences;

/// Subset of `allGeofences` (by `poiId`) currently registered with
/// CoreLocation via `startMonitoringForRegion:`.
@property (nonatomic, strong) NSMutableSet<NSString *> *armedPoiIds;
@end

@implementation TramioLocationService

RCT_EXPORT_MODULE(TramioLocationService)

+ (BOOL)requiresMainQueueSetup {
  // CLLocationManager must be created on a thread with an active run
  // loop; main is the documented choice.
  return YES;
}

- (instancetype)init {
  if ((self = [super init])) {
    _manager = [CLLocationManager new];
    _manager.delegate = self;
    _manager.pausesLocationUpdatesAutomatically = NO; // Tour decides, not iOS heuristics.
    _manager.allowsBackgroundLocationUpdates = YES;   // Permitted by Info.plist UIBackgroundModes=location.
    _manager.activityType = CLActivityTypeAutomotiveNavigation;
    _currentMode = kTramioLocationModeIdle;
    _hasJSListeners = NO;
    _highAccuracyActive = NO;
    _allGeofences = [NSMutableArray array];
    _armedPoiIds = [NSMutableSet set];
  }
  return self;
}

- (void)dealloc {
  [self stopAllNativeRequests];
  _manager.delegate = nil;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[
    kTramioLocationEventAccepted,
    kTramioLocationEventRejected,
    kTramioLocationEventGeofenceEnter,
    kTramioLocationEventGeofenceDwell,
    kTramioLocationEventGeofenceExit,
    kTramioLocationEventAccuracyChanged,
  ];
}

- (void)startObserving { self.hasJSListeners = YES; }
- (void)stopObserving  { self.hasJSListeners = NO; }

- (dispatch_queue_t)methodQueue {
  return dispatch_get_main_queue();
}

#pragma mark - JS-callable methods

RCT_EXPORT_METHOD(setMode:(NSString *)mode) {
  if (mode.length == 0) return;
  NSString *previous = self.currentMode;
  self.currentMode = mode;
  [self applyMode:mode];

  // Drive the user-visible high-accuracy indicator (Req 11.5).
  BOOL wasHigh = self.highAccuracyActive;
  BOOL nowHigh = ([mode isEqualToString:kTramioLocationModeTourApproach] ||
                  [mode isEqualToString:kTramioLocationModeReconcile]);
  self.highAccuracyActive = nowHigh;
  if (wasHigh != nowHigh && self.hasJSListeners) {
    [self sendEventWithName:kTramioLocationEventAccuracyChanged
                       body:@{ @"highAccuracy": @(nowHigh), @"mode": mode }];
  }
  os_log_info(TramioLocationLog(),
              "Location_Service: mode %{public}@ -> %{public}@ (highAccuracy=%{public}d)",
              previous, mode, nowHigh);
}

RCT_EXPORT_METHOD(armGeofences:(NSArray *)geofences) {
  [self.allGeofences removeAllObjects];
  for (id raw in geofences) {
    if (![raw isKindOfClass:[NSDictionary class]]) continue;
    TramioGeofenceEntry *entry = [self parseGeofenceDictionary:(NSDictionary *)raw];
    if (entry != nil) {
      [self.allGeofences addObject:entry];
    }
  }
  // Re-arm immediately using the most recent fix if we have one;
  // otherwise we'll arm lazily on the first accepted update.
  if (self.lastAcceptedLocation != nil) {
    [self rearmRegionsForLocation:self.lastAcceptedLocation];
  } else {
    // Without a known location we can't rank "nearest", so arm the
    // first 18 entries verbatim. The window will re-balance on the
    // first accepted update.
    [self rearmRegionsForOrdering:self.allGeofences];
  }
}

RCT_EXPORT_METHOD(disarmAll) {
  [self stopAllNativeRequests];
  [self.allGeofences removeAllObjects];
  [self.armedPoiIds removeAllObjects];
  self.currentMode = kTramioLocationModeIdle;
  self.lastAcceptedLocation = nil;
  if (self.highAccuracyActive && self.hasJSListeners) {
    [self sendEventWithName:kTramioLocationEventAccuracyChanged
                       body:@{ @"highAccuracy": @NO, @"mode": kTramioLocationModeIdle }];
  }
  self.highAccuracyActive = NO;
}

// `addListener:` and `removeListeners:` are inherited from
// `RCTEventEmitter` and satisfy the codegen-required hooks declared in
// the JS spec; no override needed.

#pragma mark - Mode application

- (void)applyMode:(NSString *)mode {
  if ([mode isEqualToString:kTramioLocationModeIdle]) {
    [self stopContinuousUpdates];
    [self.manager stopMonitoringSignificantLocationChanges];
    [self stopAllRegionMonitoring];
    return;
  }
  if ([mode isEqualToString:kTramioLocationModeStandby]) {
    [self stopContinuousUpdates];
    [self.manager startMonitoringSignificantLocationChanges];
    [self stopAllRegionMonitoring];
    return;
  }
  if ([mode isEqualToString:kTramioLocationModeTourBg]) {
    [self stopContinuousUpdates];
    [self.manager startMonitoringSignificantLocationChanges];
    [self ensureRegionMonitoring];
    return;
  }
  if ([mode isEqualToString:kTramioLocationModeTourApproach] ||
      [mode isEqualToString:kTramioLocationModeReconcile]) {
    self.manager.desiredAccuracy = kCLLocationAccuracyBest;
    self.manager.distanceFilter = kCLDistanceFilterNone;
    [self.manager startUpdatingLocation];
    [self.manager startMonitoringSignificantLocationChanges];
    [self ensureRegionMonitoring];
    return;
  }
  os_log_error(TramioLocationLog(), "Location_Service: ignoring unknown mode %{public}@", mode);
}

- (void)stopContinuousUpdates {
  [self.manager stopUpdatingLocation];
  self.manager.desiredAccuracy = kCLLocationAccuracyHundredMeters;
}

- (void)stopAllNativeRequests {
  [self stopContinuousUpdates];
  [self.manager stopMonitoringSignificantLocationChanges];
  [self stopAllRegionMonitoring];
}

- (void)stopAllRegionMonitoring {
  for (CLRegion *region in [self.manager.monitoredRegions copy]) {
    [self.manager stopMonitoringForRegion:region];
  }
  [self.armedPoiIds removeAllObjects];
}

- (void)ensureRegionMonitoring {
  // If no fixes have been received yet but the JS side has armed
  // geofences, rearm with the natural ordering so the OS at least
  // has *some* regions watching.
  if (self.armedPoiIds.count == 0 && self.allGeofences.count > 0) {
    if (self.lastAcceptedLocation != nil) {
      [self rearmRegionsForLocation:self.lastAcceptedLocation];
    } else {
      [self rearmRegionsForOrdering:self.allGeofences];
    }
  }
}

#pragma mark - Geofence parsing

- (TramioGeofenceEntry *)parseGeofenceDictionary:(NSDictionary *)dict {
  NSString *poiId = dict[@"poiId"];
  NSDictionary *geometry = dict[@"geometry"];
  NSNumber *dwell = dict[@"dwellSec"];
  if (![poiId isKindOfClass:[NSString class]] || poiId.length == 0) return nil;
  if (![geometry isKindOfClass:[NSDictionary class]]) return nil;

  NSString *kind = geometry[@"kind"];
  TramioGeofenceEntry *entry = [TramioGeofenceEntry new];
  entry.poiId = poiId;
  entry.dwellSec = [dwell isKindOfClass:[NSNumber class]] ? dwell.doubleValue : 3.0;

  if ([kind isEqualToString:@"circle"]) {
    NSArray *center = geometry[@"center"];
    NSNumber *radius = geometry[@"radiusMeters"];
    if (![center isKindOfClass:[NSArray class]] || center.count < 2) return nil;
    if (![radius isKindOfClass:[NSNumber class]]) return nil;
    entry.center = CLLocationCoordinate2DMake([center[0] doubleValue], [center[1] doubleValue]);
    entry.radiusMeters = radius.doubleValue;
    return entry;
  }
  if ([kind isEqualToString:@"polygon"]) {
    NSArray *vertices = geometry[@"vertices"];
    if (![vertices isKindOfClass:[NSArray class]] || vertices.count == 0) return nil;
    // Compute centroid + max-radius circumscribing circle. The JS-side
    // dwell stage re-checks polygon containment, so this only needs to
    // be conservative enough to wake the device.
    double sumLat = 0.0;
    double sumLon = 0.0;
    NSUInteger n = 0;
    for (NSArray *v in vertices) {
      if (![v isKindOfClass:[NSArray class]] || v.count < 2) continue;
      sumLat += [v[0] doubleValue];
      sumLon += [v[1] doubleValue];
      n++;
    }
    if (n == 0) return nil;
    CLLocationCoordinate2D centroid = CLLocationCoordinate2DMake(sumLat / n, sumLon / n);
    double maxR = 0.0;
    for (NSArray *v in vertices) {
      if (![v isKindOfClass:[NSArray class]] || v.count < 2) continue;
      CLLocationCoordinate2D p = CLLocationCoordinate2DMake([v[0] doubleValue], [v[1] doubleValue]);
      double sq = SquaredDistanceMeters(centroid, p);
      if (sq > maxR) maxR = sq;
    }
    entry.center = centroid;
    entry.radiusMeters = sqrt(maxR);
    return entry;
  }
  return nil;
}

#pragma mark - Sliding region window (Req: 20-region cap)

- (void)rearmRegionsForLocation:(CLLocation *)reference {
  NSArray<TramioGeofenceEntry *> *sorted = [self.allGeofences sortedArrayUsingComparator:
    ^NSComparisonResult(TramioGeofenceEntry *a, TramioGeofenceEntry *b) {
      double da = SquaredDistanceMeters(a.center, reference.coordinate);
      double db = SquaredDistanceMeters(b.center, reference.coordinate);
      if (da < db) return NSOrderedAscending;
      if (da > db) return NSOrderedDescending;
      return [a.poiId compare:b.poiId];
    }];
  [self rearmRegionsForOrdering:sorted];
}

- (void)rearmRegionsForOrdering:(NSArray<TramioGeofenceEntry *> *)ordered {
  NSUInteger windowSize = MIN(kTramioLocationRegionWindowSize, ordered.count);
  NSMutableSet<NSString *> *desired = [NSMutableSet setWithCapacity:windowSize];
  NSMutableDictionary<NSString *, TramioGeofenceEntry *> *desiredEntries =
      [NSMutableDictionary dictionaryWithCapacity:windowSize];
  for (NSUInteger i = 0; i < windowSize; i++) {
    TramioGeofenceEntry *entry = ordered[i];
    [desired addObject:entry.poiId];
    desiredEntries[entry.poiId] = entry;
  }

  // Stop monitoring regions that fell out of the window.
  NSMutableSet<NSString *> *toRemove = [self.armedPoiIds mutableCopy];
  [toRemove minusSet:desired];
  for (CLRegion *region in [self.manager.monitoredRegions copy]) {
    if ([toRemove containsObject:region.identifier]) {
      [self.manager stopMonitoringForRegion:region];
      [self.armedPoiIds removeObject:region.identifier];
    }
  }

  // Start monitoring regions that entered the window.
  NSMutableSet<NSString *> *toAdd = [desired mutableCopy];
  [toAdd minusSet:self.armedPoiIds];
  for (NSString *poiId in toAdd) {
    TramioGeofenceEntry *entry = desiredEntries[poiId];
    if (entry == nil) continue;
    CLLocationDistance radius = MIN(entry.radiusMeters,
                                    self.manager.maximumRegionMonitoringDistance);
    CLCircularRegion *region = [[CLCircularRegion alloc]
        initWithCenter:entry.center
                radius:MAX(radius, 1.0)
            identifier:entry.poiId];
    region.notifyOnEntry = YES;
    region.notifyOnExit = YES;
    [self.manager startMonitoringForRegion:region];
    [self.armedPoiIds addObject:poiId];
  }
}

#pragma mark - CLLocationManagerDelegate (location updates)

- (void)locationManager:(CLLocationManager *)manager didUpdateLocations:(NSArray<CLLocation *> *)locations {
  for (CLLocation *loc in locations) {
    [self ingestLocation:loc];
  }
}

- (void)locationManager:(CLLocationManager *)manager didFailWithError:(NSError *)error {
  os_log_error(TramioLocationLog(),
               "Location_Service: didFailWithError %{public}@",
               error.localizedDescription);
}

#pragma mark - Stage 1 + 2 native filtering

- (void)ingestLocation:(CLLocation *)loc {
  // Stage 1: accuracy gate (Req 5.1).
  if (loc.horizontalAccuracy < 0.0 ||
      loc.horizontalAccuracy > kTramioLocationMaxAccuracyMeters) {
    [self emitRejected:loc reason:@"accuracy"];
    return;
  }

  // Stage 2: spike rejection (Req 5.2). We compare against the most
  // recent accepted update; this is consistent with design.md's
  // pseudocode (`prev = state.lastAccepted`).
  CLLocation *prev = self.lastAcceptedLocation;
  if (prev != nil) {
    NSTimeInterval dt = [loc.timestamp timeIntervalSinceDate:prev.timestamp];
    if (dt > 0.0) {
      CLLocationDistance dist = [loc distanceFromLocation:prev];
      double mps = dist / dt;
      if (mps > kTramioLocationMaxGroundSpeedMps) {
        [self emitRejected:loc reason:@"spike"];
        return;
      }
    } else if (dt == 0.0 &&
               loc.coordinate.latitude == prev.coordinate.latitude &&
               loc.coordinate.longitude == prev.coordinate.longitude) {
      // Duplicate fix at the exact same timestamp; surface to JS so the
      // engine can keep its `LocationRejected` counter consistent
      // without polluting the smoothing window.
      [self emitRejected:loc reason:@"duplicate"];
      return;
    }
  }

  self.lastAcceptedLocation = loc;
  [self rearmRegionsForLocation:loc];
  [self emitAccepted:loc];
}

- (void)emitRejected:(CLLocation *)loc reason:(NSString *)reason {
  if (!self.hasJSListeners) return;
  [self sendEventWithName:kTramioLocationEventRejected
                     body:@{
    @"reason":     reason,
    @"ts":         @([self timestampMsFor:loc.timestamp]),
    @"coord":      @[ @(loc.coordinate.latitude), @(loc.coordinate.longitude) ],
    @"accuracyM":  @(MAX(loc.horizontalAccuracy, 0.0)),
  }];
}

- (void)emitAccepted:(CLLocation *)loc {
  if (!self.hasJSListeners) return;
  NSMutableDictionary *body = [@{
    @"ts":         @([self timestampMsFor:loc.timestamp]),
    @"coord":      @[ @(loc.coordinate.latitude), @(loc.coordinate.longitude) ],
    @"accuracyM":  @(loc.horizontalAccuracy),
    @"mode":       self.currentMode ?: kTramioLocationModeIdle,
  } mutableCopy];
  if (loc.speed >= 0.0) body[@"speedMps"] = @(loc.speed);
  if (loc.course >= 0.0) body[@"headingDeg"] = @(loc.course);
  [self sendEventWithName:kTramioLocationEventAccepted body:body];
}

- (NSTimeInterval)timestampMsFor:(NSDate *)date {
  return llround(date.timeIntervalSince1970 * 1000.0);
}

#pragma mark - CLLocationManagerDelegate (region monitoring)

- (void)locationManager:(CLLocationManager *)manager didEnterRegion:(CLRegion *)region {
  if (!self.hasJSListeners) return;
  [self sendEventWithName:kTramioLocationEventGeofenceEnter
                     body:@{
    @"poiId": region.identifier,
    @"ts":    @([self timestampMsFor:[NSDate date]]),
  }];
}

- (void)locationManager:(CLLocationManager *)manager didExitRegion:(CLRegion *)region {
  if (!self.hasJSListeners) return;
  [self sendEventWithName:kTramioLocationEventGeofenceExit
                     body:@{
    @"poiId": region.identifier,
    @"ts":    @([self timestampMsFor:[NSDate date]]),
  }];
}

// CoreLocation does not deliver native dwell events for circular
// regions on iOS (only iBeacon regions support `notifyEntryStateOnDisplay`
// dwell semantics). The dwell stage in design.md's pipeline is owned by
// JS — we emit `onGeofenceEnter` / `onGeofenceExit` and the JS-side
// reducer accumulates dwell time on smoothed updates per Stage 4.
//
// We still expose `onGeofenceDwell` in the spec because Android delivers
// the event natively; on iOS the JS-side code synthesizes it from the
// dwell accumulator and never receives it from this module.

- (void)locationManager:(CLLocationManager *)manager
    monitoringDidFailForRegion:(nullable CLRegion *)region
                     withError:(NSError *)error {
  os_log_error(TramioLocationLog(),
               "Location_Service: monitoringDidFailForRegion %{public}@: %{public}@",
               region.identifier ?: @"<nil>",
               error.localizedDescription);
}

@end
