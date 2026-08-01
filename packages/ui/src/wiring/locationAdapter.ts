// locationAdapter — bridges expo-location to the engine's geofence pipeline.
//
// The custom Location_Service turbo module (packages/native/) is not
// autolinked into the Expo prebuild, so instead we drive the already-built
// pure-JS geofence pipeline (packages/engine/src/pipeline) from real GPS
// fixes delivered by expo-location, which IS autolinked.
//
// Responsibilities:
//   - Request foreground (+ optional background) location permission.
//   - Always start a foreground watch so the tour works after the first grant.
//   - Optionally upgrade to TaskManager background updates when allowed.
//   - Feed each raw fix through `step()` (accuracy gate, spike rejection,
//     smoothing, dwell, direction filter).
//   - Emit `LocationAccepted` and `GeofenceDwell` engine events.
//   - Wave 4: Distinguish delivery from acceptance, watchdog stalls, recovery.
//
// BUG 4 FIX: Monotonic `cancelled` flag prevents async leaks. Once stop()
// is called, no further location watches or background updates can start,
// even if an awaited permission prompt resolves after the tour has ended.
//
// BUG 5 FIX: After a fire, advance the stored pipeline state's consumed
// set so the pipeline short-circuits that POI on subsequent fixes.
//
// BUG 6 FIX: Track and expose background status so the UI can warn.

import * as Location from 'expo-location';
import type { Geofence, LatLng } from '../../../engine/src';
import {
  bindLocationSession,
  ingestLocationFix,
  startBackgroundLocationUpdates,
  stopBackgroundLocationUpdates,
  unbindLocationSession,
  type LocationAdapterEvents,
} from './backgroundLocationTask';
import type { BackgroundStatus } from './TourRuntime';

export type { LocationAdapterEvents };

// ─── Wave 4: Delivery health types ───────────────────────────────────────────

/**
 * Location delivery status — distinguishes provider silence from poor accuracy.
 *
 * - `acquiring`: channel armed, no callback yet received.
 * - `live`: callbacks arriving (regardless of pipeline acceptance).
 * - `recovering`: no callback within threshold, restart in progress.
 * - `stalled`: recovery attempted but no callback arrived yet after restart.
 */
export type LocationDeliveryStatus = 'acquiring' | 'live' | 'recovering' | 'stalled';

/** Which channel is currently active. */
export type LocationChannel = 'foreground' | 'background';

export type DeliveryStatusListener = (status: LocationDeliveryStatus) => void;

/** Extended alias retained for callers; delivery hooks live on the shared session contract. */
export type LocationAdapterExtendedEvents = LocationAdapterEvents;

/** Injectable timer/clock for deterministic testing. */
export interface LocationAdapterClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Recovery configuration. */
export interface RecoveryOptions {
  /**
   * Initial stall threshold in ms. Default: 15000.
   * Justified: the engine's Dead Reckoning starts at 15s, so recovery
   * should trigger at the same boundary to prevent DR from advancing
   * on dead data.
   */
  stallThresholdMs?: number;
  /** Maximum backoff delay in ms. Default: 60000. */
  maxBackoffMs?: number;
  /** Backoff multiplier. Default: 2. */
  backoffMultiplier?: number;
  /** Maximum recovery attempts to expose to UI (cap for counter). Default: 99. */
  maxRecoveryCountForUI?: number;
}

const DEFAULT_STALL_THRESHOLD_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_RECOVERY_COUNT = 99;

/**
 * Drives the engine geofence pipeline from real expo-location fixes.
 *
 * Construct once per tour with the route + geofences, call `start()` to
 * begin watching, and `stop()` to release the watch subscription.
 */
export class LocationAdapter {
  private watch: Location.LocationSubscription | null = null;
  private readonly route: readonly LatLng[];
  private readonly geofences: readonly Geofence[];
  private readonly events: LocationAdapterExtendedEvents;
  private active = false;

  // BUG 4 FIX: monotonic cancellation flag. Once set, no async continuation
  // may create watches or start background updates.
  private cancelled = false;

  /** Callback wired by TourRuntime to receive background status changes. */
  onBackgroundStatusChange: ((status: BackgroundStatus) => void) | null = null;

  // ─── Wave 4: Watchdog & recovery state ──────────────────────────────
  private readonly clock: LocationAdapterClock;
  private readonly recoveryOpts: Required<RecoveryOptions>;

  private deliveryStatus: LocationDeliveryStatus = 'acquiring';
  private deliveryStatusListeners = new Set<DeliveryStatusListener>();
  private activeChannel: LocationChannel = 'foreground';
  private watchdogTimer: unknown = null;
  private currentStallThreshold: number;
  private recoveryCount = 0;
  private recovering = false;

  /**
   * Generation counter. Incremented on stop() and on each recovery cycle.
   * Stale callbacks from a previous generation are ignored.
   */
  private generation = 0;
  /** Invalidates callbacks retained by a removed foreground subscription. */
  private foregroundWatchGeneration = 0;

  /** Callback for diagnostics integration. */
  onRecoveryAttempt: (() => void) | null = null;
  onRecoverySuccess: (() => void) | null = null;
  onRecoveryFailure: (() => void) | null = null;
  onChannelChange: ((channel: LocationChannel) => void) | null = null;

  constructor(
    route: readonly LatLng[],
    geofences: readonly Geofence[],
    events: LocationAdapterExtendedEvents,
    options?: { clock?: LocationAdapterClock; recovery?: RecoveryOptions },
  ) {
    this.route = route;
    this.geofences = geofences;
    this.events = events;
    this.clock = options?.clock ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.recoveryOpts = {
      stallThresholdMs: options?.recovery?.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS,
      maxBackoffMs: options?.recovery?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      backoffMultiplier: options?.recovery?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER,
      maxRecoveryCountForUI: options?.recovery?.maxRecoveryCountForUI ?? DEFAULT_MAX_RECOVERY_COUNT,
    };
    this.currentStallThreshold = this.recoveryOpts.stallThresholdMs;
  }

  // ─── Wave 4: Public delivery status API ─────────────────────────────

  getDeliveryStatus(): LocationDeliveryStatus {
    return this.deliveryStatus;
  }

  getRecoveryCount(): number {
    return Math.min(this.recoveryCount, this.recoveryOpts.maxRecoveryCountForUI);
  }

  getActiveChannel(): LocationChannel {
    return this.activeChannel;
  }

  subscribeDeliveryStatus(listener: DeliveryStatusListener): () => void {
    this.deliveryStatusListeners.add(listener);
    return () => {
      this.deliveryStatusListeners.delete(listener);
    };
  }

  /**
   * Request immediate recovery if stalled/recovering and not rate-limited.
   * Called e.g. on AppState 'active' transition.
   */
  requestImmediateRecovery(): void {
    if (this.cancelled) return;
    if (this.deliveryStatus !== 'stalled' && this.deliveryStatus !== 'recovering') return;
    // Reuse the scheduled recovery path — cancel current timer and trigger now.
    this.clearWatchdog();
    void this.attemptRecovery();
  }

  // ─── Existing public API ────────────────────────────────────────────

  /**
   * Request permission and begin watching position. Resolves once the
   * watch is established (or rejects to the permission-denied callback).
   */
  async start(): Promise<void> {
    const { status } = await Location.requestForegroundPermissionsAsync();

    // BUG 4 FIX: check cancellation after every await.
    if (this.cancelled) return;

    if (status !== Location.PermissionStatus.GRANTED) {
      this.events.onPermissionDenied();
      return;
    }

    this.active = true;
    bindLocationSession(
      this.route,
      this.geofences,
      {
        ...this.events,
        onDelivered: (meta) => this.noteRawDelivery(meta.accuracyM),
        onRejected: (meta) => this.events.onRejected?.(meta),
      },
      () => this.active,
    );

    // Foreground watch first — reliable on all platforms and permission states.
    await this.startForegroundWatch();

    // BUG 4 FIX: check cancellation after foreground watch.
    if (this.cancelled) return;

    // Wave 4: arm the watchdog once the channel is armed.
    this.armWatchdog();

    // Background is optional; never tear down a working foreground watch on failure.
    await this.tryEnableBackgroundUpdates();
  }

  /** Stop watching and release the subscription. Monotonic — cannot be undone. */
  stop(): void {
    // BUG 4 FIX: set the permanent cancellation flag so no async
    // continuation can re-arm watches after this point.
    this.cancelled = true;
    this.active = false;
    this.generation++;
    this.foregroundWatchGeneration++;
    this.clearWatchdog();
    if (this.watch) {
      this.watch.remove();
      this.watch = null;
    }
    void stopBackgroundLocationUpdates().catch(() => undefined);
    unbindLocationSession();
  }

  // ─── Wave 4: Raw delivery hook ─────────────────────────────────────

  /**
   * Feed a foreground provider callback into the session pipeline. Delivery
   * liveness is recorded centrally by `ingestLocationFix`, so TaskManager and
   * foreground callbacks have identical watchdog semantics.
   */
  handleRawDelivery(loc: Location.LocationObject): void {
    if (this.cancelled) return;
    ingestLocationFix(loc);
  }

  private noteRawDelivery(accuracyM: number | null): void {
    if (this.cancelled) return;
    const recovered = this.deliveryStatus === 'recovering' || this.deliveryStatus === 'stalled';

    // Privacy-safe metadata only: no coordinate or provider timestamp.
    this.events.onDelivered?.({ accuracyM });

    // A fresh callback, even if subsequently rejected, proves delivery recovered.
    if (recovered) this.onRecoverySuccess?.();
    this.recoveryCount = 0;
    this.resetWatchdog();
  }

  // ─── Watchdog & Recovery (private) ──────────────────────────────────

  private armWatchdog(): void {
    if (this.cancelled) return;
    this.clearWatchdog();
    const gen = this.generation;
    this.watchdogTimer = this.clock.setTimeout(() => {
      if (this.cancelled || this.generation !== gen) return;
      this.watchdogTimer = null;
      this.handleStall();
    }, this.currentStallThreshold);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer !== null) {
      this.clock.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private resetWatchdog(): void {
    if (this.cancelled) return;
    // Transition to live.
    this.setDeliveryStatus('live');
    // Reset backoff on successful delivery.
    this.currentStallThreshold = this.recoveryOpts.stallThresholdMs;
    // Re-arm.
    this.armWatchdog();
  }

  private handleStall(): void {
    if (this.cancelled) return;
    this.setDeliveryStatus('recovering');
    void this.attemptRecovery();
  }

  private async attemptRecovery(): Promise<void> {
    if (this.cancelled) return;
    // Serialize: only one recovery at a time.
    if (this.recovering) return;
    this.recovering = true;
    const gen = this.generation;

    this.recoveryCount++;
    this.onRecoveryAttempt?.();

    try {
      if (this.activeChannel === 'background') {
        await this.recoverBackgroundChannel(gen);
      } else {
        await this.recoverForegroundChannel(gen);
      }
    } finally {
      this.recovering = false;
    }

    // After recovery attempt, if still no delivery, go to stalled + backoff.
    if (this.cancelled || this.generation !== gen) return;
    if (this.deliveryStatus === 'recovering') {
      this.setDeliveryStatus('stalled');
      // Increase backoff.
      this.currentStallThreshold = Math.min(
        this.currentStallThreshold * this.recoveryOpts.backoffMultiplier,
        this.recoveryOpts.maxBackoffMs,
      );
      this.armWatchdog();
    }
  }

  private async recoverForegroundChannel(gen: number): Promise<void> {
    // Remove and recreate the foreground watch.
    if (this.watch) {
      this.foregroundWatchGeneration++;
      this.watch.remove();
      this.watch = null;
    }
    if (this.cancelled || this.generation !== gen) return;

    const watchGen = ++this.foregroundWatchGeneration;
    try {
      const subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 1000,
          distanceInterval: 1,
        },
        (loc) => {
          if (this.foregroundWatchGeneration !== watchGen) return;
          this.handleRawDelivery(loc);
        },
      );

      if (
        this.cancelled ||
        this.generation !== gen ||
        this.foregroundWatchGeneration !== watchGen
      ) {
        subscription.remove();
        return;
      }

      this.watch = subscription;
    } catch {
      if (this.cancelled || this.generation !== gen) return;
      this.onRecoveryFailure?.();
    }
  }

  private async recoverBackgroundChannel(gen: number): Promise<void> {
    try {
      // Use existing idempotent stop/start.
      await stopBackgroundLocationUpdates();
      if (this.cancelled || this.generation !== gen) return;
      await startBackgroundLocationUpdates();
      if (this.cancelled || this.generation !== gen) return;
    } catch {
      if (this.cancelled || this.generation !== gen) return;
      // Background restart failed — fall back to foreground.
      this.onRecoveryFailure?.();
      this.activeChannel = 'foreground';
      this.onChannelChange?.('foreground');
      this.onBackgroundStatusChange?.({
        mode: 'foreground-only',
        reason: 'unavailable',
      });
      // Arm a foreground watch instead.
      await this.recoverForegroundChannel(gen);
    }
  }

  private setDeliveryStatus(next: LocationDeliveryStatus): void {
    if (this.deliveryStatus === next) return;
    this.deliveryStatus = next;
    for (const listener of this.deliveryStatusListeners) listener(next);
  }

  // ─── Existing private methods ───────────────────────────────────────

  private async startForegroundWatch(): Promise<void> {
    if (this.watch) return;
    if (this.cancelled) return;

    const gen = this.generation;
    const watchGen = ++this.foregroundWatchGeneration;
    const subscription = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 1000,
        distanceInterval: 1,
      },
      (loc) => {
        if (this.foregroundWatchGeneration !== watchGen) return;
        this.handleRawDelivery(loc);
      },
    );

    // BUG 4 FIX: if cancelled or replaced while awaiting, immediately remove.
    if (this.cancelled || this.generation !== gen || this.foregroundWatchGeneration !== watchGen) {
      subscription.remove();
      return;
    }

    this.watch = subscription;
    this.activeChannel = 'foreground';
    this.onChannelChange?.('foreground');
  }

  private async tryEnableBackgroundUpdates(): Promise<void> {
    try {
      if (this.cancelled) return;

      let bgStatus = (await Location.getBackgroundPermissionsAsync()).status;

      if (this.cancelled) return;

      if (bgStatus !== Location.PermissionStatus.GRANTED) {
        bgStatus = (await Location.requestBackgroundPermissionsAsync()).status;
      }

      if (this.cancelled) return;

      if (bgStatus !== Location.PermissionStatus.GRANTED) {
        this.onBackgroundStatusChange?.({
          mode: 'foreground-only',
          reason: 'permission-denied',
        });
        return;
      }

      await startBackgroundLocationUpdates();

      // BUG 4 FIX: if cancelled while starting background updates, stop them.
      if (this.cancelled) {
        void stopBackgroundLocationUpdates().catch(() => undefined);
        return;
      }

      // Background updates are running — remove the foreground watch to avoid
      // duplicate fixes (background delivery also fires while foregrounded).
      if (this.watch) {
        this.foregroundWatchGeneration++;
        this.watch.remove();
        this.watch = null;
      }

      this.activeChannel = 'background';
      this.onChannelChange?.('background');
      this.onBackgroundStatusChange?.({ mode: 'background' });
    } catch (err: unknown) {
      // BUG 6 FIX: categorize the failure so the UI can show a reason.
      if (this.cancelled) return;

      const message = err instanceof Error ? err.message : '';
      if (message.includes('POST_NOTIFICATIONS')) {
        this.onBackgroundStatusChange?.({
          mode: 'foreground-only',
          reason: 'notifications-denied',
        });
      } else {
        this.onBackgroundStatusChange?.({
          mode: 'foreground-only',
          reason: 'unavailable',
        });
      }
      // Foreground watch keeps the tour running — no rethrow.
    }
  }
}
