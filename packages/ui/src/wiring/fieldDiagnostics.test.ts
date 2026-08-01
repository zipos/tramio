// fieldDiagnostics.test.ts — Wave 4: Privacy-safe diagnostics recorder tests.
//
// Key assertions:
//   - Report contains NO coordinates, lat/lon, bundle IDs, POI IDs,
//     wall timestamps, or free-form error messages.
//   - Counters and enum events are correct.
//   - Ring and byte cap work.
//   - Deterministic with injected clock.

import {
  FieldDiagnosticsRecorder,
  bucketAccuracy,
  type DiagnosticsClock,
  type FieldDiagnosticsReport,
} from './fieldDiagnostics';

function makeClock(start = 1000): DiagnosticsClock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe('FieldDiagnosticsRecorder', () => {
  describe('bucketAccuracy', () => {
    it('buckets correctly', () => {
      expect(bucketAccuracy(5)).toBe('<=10');
      expect(bucketAccuracy(10)).toBe('<=10');
      expect(bucketAccuracy(11)).toBe('<=25');
      expect(bucketAccuracy(25)).toBe('<=25');
      expect(bucketAccuracy(26)).toBe('<=50');
      expect(bucketAccuracy(50)).toBe('<=50');
      expect(bucketAccuracy(51)).toBe('>50');
      expect(bucketAccuracy(null)).toBe('unknown');
      expect(bucketAccuracy(undefined)).toBe('unknown');
      expect(bucketAccuracy(-1)).toBe('unknown');
    });
  });

  describe('counters', () => {
    it('records delivery, acceptance, and rejection counts', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });

      recorder.recordDelivery(8);
      recorder.recordAccepted();
      recorder.recordDelivery(60);
      recorder.recordRejected('accuracy');
      recorder.recordDelivery(5);
      recorder.recordRejected('spike');
      recorder.recordGeofenceFire();
      recorder.recordRecoveryAttempt();
      recorder.recordRecoverySuccess();
      recorder.recordRecoveryAttempt();
      recorder.recordRecoveryFailure();

      clock.advance(5000);
      recorder.finalize();

      const report: FieldDiagnosticsReport = JSON.parse(recorder.exportReport());

      expect(report.counters.rawDeliveries).toBe(3);
      expect(report.counters.accepted).toBe(1);
      expect(report.counters.rejectedAccuracy).toBe(1);
      expect(report.counters.rejectedSpike).toBe(1);
      expect(report.counters.geofenceFires).toBe(1);
      expect(report.counters.recoveryAttempts).toBe(2);
      expect(report.counters.recoverySuccesses).toBe(1);
      expect(report.counters.recoveryFailures).toBe(1);
    });
  });

  describe('accuracy distribution', () => {
    it('counts buckets correctly', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });

      recorder.recordDelivery(5); // <=10
      recorder.recordDelivery(15); // <=25
      recorder.recordDelivery(30); // <=50
      recorder.recordDelivery(100); // >50
      recorder.recordDelivery(null); // unknown

      const report: FieldDiagnosticsReport = JSON.parse(recorder.exportReport());

      expect(report.accuracyDistribution['<=10']).toBe(1);
      expect(report.accuracyDistribution['<=25']).toBe(1);
      expect(report.accuracyDistribution['<=50']).toBe(1);
      expect(report.accuracyDistribution['>50']).toBe(1);
      expect(report.accuracyDistribution.unknown).toBe(1);
    });
  });

  describe('privacy guarantees', () => {
    it('report contains no lat/lon/coordinates', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });

      // Simulate a session with many events.
      recorder.recordDelivery(8);
      recorder.recordAccepted();
      recorder.recordGeofenceFire();
      recorder.recordChannelTransition('background');
      clock.advance(2000);
      recorder.finalize();

      const report = recorder.exportReport();

      // These are actual Warsaw bus 180 coordinates — must NOT appear.
      expect(report).not.toMatch(/52\.\d+/);
      expect(report).not.toMatch(/21\.\d+/);
      expect(report).not.toMatch(/latitude/i);
      expect(report).not.toMatch(/longitude/i);
      expect(report).not.toMatch(/\bcoord\b/i);
      expect(report).not.toMatch(/\blat\b/i);
      expect(report).not.toMatch(/\blon\b/i);
    });

    it('report contains no bundle/POI/route IDs', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });
      recorder.recordDelivery(10);
      recorder.finalize();

      const report = recorder.exportReport();

      expect(report).not.toMatch(/bundleId/i);
      expect(report).not.toMatch(/poiId/i);
      expect(report).not.toMatch(/warsaw/i);
      expect(report).not.toMatch(/poi-/);
      expect(report).not.toMatch(/bus-180/);
    });

    it('report contains no wall-clock timestamps', () => {
      const clock = makeClock(1722470868816); // realistic epoch ms
      const recorder = new FieldDiagnosticsRecorder({ clock });
      recorder.recordDelivery(10);
      clock.advance(3000);
      recorder.finalize();

      const report = recorder.exportReport();

      // The start epoch must not appear in the report.
      expect(report).not.toContain('1722470868816');
      expect(report).not.toContain('1722470');
      // Only relative quantized elapsed should appear.
      const parsed: FieldDiagnosticsReport = JSON.parse(report);
      expect(parsed.durationMs).toBe(3000); // quantized
      for (const entry of parsed.lifecycleRing) {
        // All elapsed values are relative and quantized to 500ms.
        expect(entry.elapsedMs % 500).toBe(0);
        expect(entry.elapsedMs).toBeLessThanOrEqual(3000);
      }
    });

    it('report contains no free-form error messages', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });
      recorder.recordRecoveryFailure();
      recorder.finalize();

      const report = recorder.exportReport();
      const parsed: FieldDiagnosticsReport = JSON.parse(report);

      // Only fixed enum transitions in the ring.
      const validTransitions = new Set([
        'tour_started',
        'tour_ended',
        'fix_delivered',
        'fix_accepted',
        'fix_rejected_accuracy',
        'fix_rejected_spike',
        'geofence_fired',
        'recovery_attempt',
        'recovery_success',
        'recovery_failure',
        'channel_foreground',
        'channel_background',
        'channel_foreground_only_degraded',
        'stall_detected',
        'watchdog_reset',
      ]);
      for (const entry of parsed.lifecycleRing) {
        expect(validTransitions.has(entry.transition)).toBe(true);
      }
    });

    it('report contains explicit privacy statement', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });
      recorder.finalize();
      const parsed: FieldDiagnosticsReport = JSON.parse(recorder.exportReport());
      expect(parsed.privacyStatement).toContain('NO coordinates');
      expect(parsed.privacyStatement).toContain('NO');
    });
  });

  describe('ring cap', () => {
    it('ring is bounded at maxRingSize', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock, maxRingSize: 5 });

      // Push more than 5 events (tour_started is already 1).
      for (let i = 0; i < 10; i++) {
        recorder.recordDelivery(10);
      }

      const parsed: FieldDiagnosticsReport = JSON.parse(recorder.exportReport());
      expect(parsed.lifecycleRing.length).toBeLessThanOrEqual(5);
    });
  });

  describe('byte cap', () => {
    it('report respects maxReportBytes', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({
        clock,
        maxRingSize: 500,
        maxReportBytes: 2048,
      });

      // Generate many events to exceed the byte cap.
      for (let i = 0; i < 300; i++) {
        clock.advance(100);
        recorder.recordDelivery(10);
      }
      recorder.finalize();

      const report = recorder.exportReport();
      expect(report.length).toBeLessThanOrEqual(2048);
    });
  });

  describe('finalization', () => {
    it('ignores events after finalize', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });

      recorder.recordDelivery(10);
      recorder.finalize();
      recorder.recordDelivery(10);
      recorder.recordAccepted();

      const parsed: FieldDiagnosticsReport = JSON.parse(recorder.exportReport());
      expect(parsed.counters.rawDeliveries).toBe(1);
      expect(parsed.counters.accepted).toBe(0);
    });
  });

  describe('deterministic clock', () => {
    it('elapsed times use quantized clock values', () => {
      const clock = makeClock(0);
      const recorder = new FieldDiagnosticsRecorder({ clock });

      clock.advance(750); // should quantize to 500 or 1000
      recorder.recordDelivery(10);

      clock.advance(1250); // total 2000, quantized
      recorder.recordAccepted();

      const parsed: FieldDiagnosticsReport = JSON.parse(recorder.exportReport());
      // The first entry is tour_started at 0.
      expect(parsed.lifecycleRing[0]!.elapsedMs).toBe(0);
      // Second entry at 750ms → quantized to 500 (Math.round(750/500)*500 = 500? no: round(1.5)=2 → 1000)
      expect(parsed.lifecycleRing[1]!.elapsedMs % 500).toBe(0);
    });
  });

  describe('delivery status history', () => {
    it('records status transitions bounded', () => {
      const clock = makeClock();
      const recorder = new FieldDiagnosticsRecorder({ clock });

      recorder.recordDeliveryStatus('live');
      recorder.recordDeliveryStatus('recovering');
      recorder.recordDeliveryStatus('stalled');
      recorder.recordDeliveryStatus('live');

      const parsed: FieldDiagnosticsReport = JSON.parse(recorder.exportReport());
      expect(parsed.deliveryStatusHistory).toEqual(['live', 'recovering', 'stalled', 'live']);
    });
  });
});
