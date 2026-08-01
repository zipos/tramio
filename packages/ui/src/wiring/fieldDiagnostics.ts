// fieldDiagnostics — Privacy-safe bounded diagnostics recorder.
//
// Wave 4: Provides coordinate-free, identity-free field diagnostics for
// debugging GPS delivery stalls and tour behavior on real rides.
//
// PRIVACY CONTRACT:
//   - NO coordinates, lat/lon, raw location timestamps, or position data.
//   - NO route/bundle/POI IDs, narrative text, account/device identifiers.
//   - NO free-form exception messages or exact OS version strings.
//   - Accuracy is bucketed (never exact). Timestamps are relative elapsed only.
//   - Error categories are fixed enums — no dynamic string content.
//   - Report is deterministic given the same input sequence.
//
// The recorder lives in memory only. No automatic upload, no network I/O.
// The user must explicitly press "Share diagnostics" to export.

// ─── Types ────────────────────────────────────────────────────────────────────

/** Accuracy bucket — never expose raw accuracy values. */
export type AccuracyBucket = '<=10' | '<=25' | '<=50' | '>50' | 'unknown';

/** Fixed enum of rejection reasons from the pipeline. */
export type RejectionCategory = 'accuracy' | 'spike';

/** Fixed enum of lifecycle transitions. */
export type LifecycleTransition =
  | 'tour_started'
  | 'tour_ended'
  | 'fix_delivered'
  | 'fix_accepted'
  | 'fix_rejected_accuracy'
  | 'fix_rejected_spike'
  | 'geofence_fired'
  | 'recovery_attempt'
  | 'recovery_success'
  | 'recovery_failure'
  | 'channel_foreground'
  | 'channel_background'
  | 'channel_foreground_only_degraded'
  | 'stall_detected'
  | 'watchdog_reset';

/** Fixed enum of delivery status states. */
export type DeliveryStatusEvent = 'acquiring' | 'live' | 'recovering' | 'stalled';

/** A single lifecycle ring entry — enum + quantized elapsed ms. */
export interface LifecycleEntry {
  readonly transition: LifecycleTransition;
  /** Elapsed ms since recorder start, quantized to 500ms buckets. */
  readonly elapsedMs: number;
}

/** Injectable clock for deterministic testing. */
export interface DiagnosticsClock {
  now(): number;
}

/** Options for the recorder. */
export interface FieldDiagnosticsOptions {
  clock?: DiagnosticsClock;
  /** Maximum entries in the lifecycle ring. Default: 200. */
  maxRingSize?: number;
  /** Maximum serialized report size in bytes. Default: 8192. */
  maxReportBytes?: number;
}

/** The versioned report structure. */
export interface FieldDiagnosticsReport {
  readonly version: 1;
  readonly privacyStatement: string;
  readonly durationMs: number;
  readonly counters: DiagnosticsCounters;
  readonly accuracyDistribution: Readonly<Record<AccuracyBucket, number>>;
  readonly deliveryStatusHistory: readonly DeliveryStatusEvent[];
  readonly lifecycleRing: readonly LifecycleEntry[];
}

export interface DiagnosticsCounters {
  readonly rawDeliveries: number;
  readonly accepted: number;
  readonly rejectedAccuracy: number;
  readonly rejectedSpike: number;
  readonly geofenceFires: number;
  readonly recoveryAttempts: number;
  readonly recoverySuccesses: number;
  readonly recoveryFailures: number;
  readonly channelTransitions: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RING_SIZE = 200;
const DEFAULT_MAX_REPORT_BYTES = 8192;
const ELAPSED_QUANTIZATION_MS = 500;
/** Maximum delivery status history entries. */
const MAX_STATUS_HISTORY = 50;

const PRIVACY_STATEMENT =
  'This report contains NO coordinates, raw location samples, route/bundle/POI IDs, ' +
  'account identifiers, device IDs, OS version, narrative text, or timestamps. ' +
  'Accuracy is bucketed. Elapsed times are relative and quantized. ' +
  'Error categories are fixed enums only.';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function bucketAccuracy(accuracyM: number | undefined | null): AccuracyBucket {
  if (accuracyM == null || accuracyM < 0) return 'unknown';
  if (accuracyM <= 10) return '<=10';
  if (accuracyM <= 25) return '<=25';
  if (accuracyM <= 50) return '<=50';
  return '>50';
}

function quantizeElapsed(ms: number): number {
  return Math.round(ms / ELAPSED_QUANTIZATION_MS) * ELAPSED_QUANTIZATION_MS;
}

// ─── Recorder ─────────────────────────────────────────────────────────────────

export class FieldDiagnosticsRecorder {
  private readonly clock: DiagnosticsClock;
  private readonly maxRingSize: number;
  private readonly maxReportBytes: number;
  private readonly startedAt: number;

  // Counters
  private rawDeliveries = 0;
  private accepted = 0;
  private rejectedAccuracy = 0;
  private rejectedSpike = 0;
  private geofenceFires = 0;
  private recoveryAttempts = 0;
  private recoverySuccesses = 0;
  private recoveryFailures = 0;
  private channelTransitions = 0;

  // Accuracy distribution
  private accuracyDist: Record<AccuracyBucket, number> = {
    '<=10': 0,
    '<=25': 0,
    '<=50': 0,
    '>50': 0,
    unknown: 0,
  };

  // Bounded ring of lifecycle transitions
  private ring: LifecycleEntry[] = [];

  // Delivery status history (bounded)
  private statusHistory: DeliveryStatusEvent[] = [];

  private finalized = false;

  constructor(options?: FieldDiagnosticsOptions) {
    this.clock = options?.clock ?? { now: () => Date.now() };
    this.maxRingSize = options?.maxRingSize ?? DEFAULT_MAX_RING_SIZE;
    this.maxReportBytes = options?.maxReportBytes ?? DEFAULT_MAX_REPORT_BYTES;
    this.startedAt = this.clock.now();
    this.pushRing('tour_started');
  }

  // ─── Recording API ────────────────────────────────────────────────────

  /** Record a raw GPS callback delivery (before pipeline filtering). */
  recordDelivery(accuracyM: number | undefined | null): void {
    if (this.finalized) return;
    this.rawDeliveries++;
    const bucket = bucketAccuracy(accuracyM);
    this.accuracyDist[bucket]++;
    this.pushRing('fix_delivered');
  }

  /** Record an accepted fix (passed pipeline). */
  recordAccepted(): void {
    if (this.finalized) return;
    this.accepted++;
    this.pushRing('fix_accepted');
  }

  /** Record a rejected fix with the category. */
  recordRejected(category: RejectionCategory): void {
    if (this.finalized) return;
    if (category === 'accuracy') {
      this.rejectedAccuracy++;
      this.pushRing('fix_rejected_accuracy');
    } else {
      this.rejectedSpike++;
      this.pushRing('fix_rejected_spike');
    }
  }

  /** Record a geofence fire. */
  recordGeofenceFire(): void {
    if (this.finalized) return;
    this.geofenceFires++;
    this.pushRing('geofence_fired');
  }

  /** Record a recovery attempt. */
  recordRecoveryAttempt(): void {
    if (this.finalized) return;
    this.recoveryAttempts++;
    this.pushRing('recovery_attempt');
  }

  /** Record recovery success. */
  recordRecoverySuccess(): void {
    if (this.finalized) return;
    this.recoverySuccesses++;
    this.pushRing('recovery_success');
  }

  /** Record recovery failure. */
  recordRecoveryFailure(): void {
    if (this.finalized) return;
    this.recoveryFailures++;
    this.pushRing('recovery_failure');
  }

  /** Record a channel transition. */
  recordChannelTransition(channel: 'foreground' | 'background' | 'foreground_only_degraded'): void {
    if (this.finalized) return;
    this.channelTransitions++;
    if (channel === 'foreground') {
      this.pushRing('channel_foreground');
    } else if (channel === 'background') {
      this.pushRing('channel_background');
    } else {
      this.pushRing('channel_foreground_only_degraded');
    }
  }

  /** Record a stall detection. */
  recordStallDetected(): void {
    if (this.finalized) return;
    this.pushRing('stall_detected');
  }

  /** Record a delivery status change. */
  recordDeliveryStatus(status: DeliveryStatusEvent): void {
    if (this.finalized) return;
    if (this.statusHistory.length >= MAX_STATUS_HISTORY) {
      this.statusHistory.shift();
    }
    this.statusHistory.push(status);
  }

  /** Record watchdog reset (new callback arrived). */
  recordWatchdogReset(): void {
    if (this.finalized) return;
    this.pushRing('watchdog_reset');
  }

  // ─── Finalization & Export ────────────────────────────────────────────

  /** Finalize the recorder (no more events accepted). */
  finalize(): void {
    if (this.finalized) return;
    this.pushRing('tour_ended');
    this.finalized = true;
  }

  /** Export the report as a deterministic JSON string. */
  exportReport(): string {
    const report: FieldDiagnosticsReport = {
      version: 1,
      privacyStatement: PRIVACY_STATEMENT,
      durationMs: quantizeElapsed(this.clock.now() - this.startedAt),
      counters: {
        rawDeliveries: this.rawDeliveries,
        accepted: this.accepted,
        rejectedAccuracy: this.rejectedAccuracy,
        rejectedSpike: this.rejectedSpike,
        geofenceFires: this.geofenceFires,
        recoveryAttempts: this.recoveryAttempts,
        recoverySuccesses: this.recoverySuccesses,
        recoveryFailures: this.recoveryFailures,
        channelTransitions: this.channelTransitions,
      },
      accuracyDistribution: { ...this.accuracyDist },
      deliveryStatusHistory: [...this.statusHistory],
      lifecycleRing: [...this.ring],
    };

    let json = JSON.stringify(report, null, 2);

    // Cap serialized size by truncating the ring if needed.
    if (json.length > this.maxReportBytes) {
      const trimmedRing = this.ring.slice(-Math.floor(this.ring.length / 2));
      const trimmedReport = { ...report, lifecycleRing: trimmedRing };
      json = JSON.stringify(trimmedReport, null, 2);
      if (json.length > this.maxReportBytes) {
        // Final fallback: counters only, no ring.
        const minReport = { ...report, lifecycleRing: [], deliveryStatusHistory: [] };
        json = JSON.stringify(minReport, null, 2);
      }
    }

    return json;
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  private pushRing(transition: LifecycleTransition): void {
    const elapsed = quantizeElapsed(this.clock.now() - this.startedAt);
    if (this.ring.length >= this.maxRingSize) {
      this.ring.shift();
    }
    this.ring.push({ transition, elapsedMs: elapsed });
  }
}
