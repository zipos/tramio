/**
 * Unit tests for flag-driven command translators (task 9.2).
 *
 * Validates: Requirements 15.2, 15.3, 15.4
 *
 * Key assertions:
 *   - Translators select modern path when the relevant flag is true.
 *   - Translators select fallback path when the relevant flag is false.
 *   - Translators NEVER check OS version directly — only capability flags.
 *   - The crypto translator correctly handles the two-flag composition
 *     (secureEnclaveAvailable + strongBoxAvailable).
 */

import { probeCapabilities, defaultCapabilities } from './probes';
import {
  locationTranslator,
  audioTranslator,
  foregroundServiceTranslator,
  cryptoTranslator,
} from './translators';
import type {
  AudioTranslatorActions,
  CryptoTranslatorActions,
  ForegroundServiceTranslatorActions,
  LocationTranslatorActions,
} from './translators';
import type { Capabilities } from './types';

// ---------------------------------------------------------------------------
// Helpers: mock action sets
// ---------------------------------------------------------------------------

function mockLocationActions(label: string): LocationTranslatorActions {
  return {
    armGeofences: jest.fn().mockImplementation(() => label),
    disarmAll: jest.fn().mockImplementation(() => label),
    setMode: jest.fn().mockImplementation(() => label),
  };
}

function mockAudioActions(label: string): AudioTranslatorActions {
  return {
    play: jest.fn().mockImplementation(() => label),
    pause: jest.fn().mockImplementation(() => label),
    resume: jest.fn().mockImplementation(() => label),
    stop: jest.fn().mockImplementation(() => label),
  };
}

function mockForegroundServiceActions(label: string): ForegroundServiceTranslatorActions {
  return {
    startForegroundService: jest.fn().mockImplementation(() => label),
    stopForegroundService: jest.fn().mockImplementation(() => label),
  };
}

function mockCryptoActions(label: string): CryptoTranslatorActions {
  return {
    ensureHardwareSecret: jest.fn().mockResolvedValue(undefined),
    openDecryptedStream: jest.fn().mockResolvedValue(label),
  };
}

// ---------------------------------------------------------------------------
// locationTranslator
// ---------------------------------------------------------------------------

describe('locationTranslator', () => {
  it('selects modern path when regionMonitoringV2 is true', () => {
    // iOS 17 has regionMonitoringV2 = true per OS_MATRIX
    const caps: Capabilities = probeCapabilities('ios', 17);
    expect(caps.regionMonitoringV2).toBe(true);

    const modern = mockLocationActions('modern');
    const fallback = mockLocationActions('fallback');
    const result = locationTranslator(caps, { modern, fallback });

    expect(result).toBe(modern);
  });

  it('selects fallback path when regionMonitoringV2 is false', () => {
    // Conservative baseline has all flags false
    const caps: Capabilities = defaultCapabilities();
    expect(caps.regionMonitoringV2).toBe(false);

    const modern = mockLocationActions('modern');
    const fallback = mockLocationActions('fallback');
    const result = locationTranslator(caps, { modern, fallback });

    expect(result).toBe(fallback);
  });

  it('selects fallback on iOS 16 (below regionMonitoringV2 floor)', () => {
    const caps: Capabilities = probeCapabilities('ios', 16);
    expect(caps.regionMonitoringV2).toBe(false);

    const modern = mockLocationActions('modern');
    const fallback = mockLocationActions('fallback');
    const result = locationTranslator(caps, { modern, fallback });

    expect(result).toBe(fallback);
  });

  it('selects modern on Android 31 (at regionMonitoringV2 floor)', () => {
    const caps: Capabilities = probeCapabilities('android', 31);
    expect(caps.regionMonitoringV2).toBe(true);

    const modern = mockLocationActions('modern');
    const fallback = mockLocationActions('fallback');
    const result = locationTranslator(caps, { modern, fallback });

    expect(result).toBe(modern);
  });
});

// ---------------------------------------------------------------------------
// audioTranslator
// ---------------------------------------------------------------------------

describe('audioTranslator', () => {
  it('selects modern path when isolatedAudioFocus is true', () => {
    // Android 31 has isolatedAudioFocus = true per OS_MATRIX
    const caps: Capabilities = probeCapabilities('android', 31);
    expect(caps.isolatedAudioFocus).toBe(true);

    const modern = mockAudioActions('modern');
    const fallback = mockAudioActions('fallback');
    const result = audioTranslator(caps, { modern, fallback });

    expect(result).toBe(modern);
  });

  it('selects fallback path when isolatedAudioFocus is false', () => {
    const caps: Capabilities = defaultCapabilities();
    expect(caps.isolatedAudioFocus).toBe(false);

    const modern = mockAudioActions('modern');
    const fallback = mockAudioActions('fallback');
    const result = audioTranslator(caps, { modern, fallback });

    expect(result).toBe(fallback);
  });

  it('selects modern on iOS 14 (at isolatedAudioFocus floor)', () => {
    const caps: Capabilities = probeCapabilities('ios', 14);
    expect(caps.isolatedAudioFocus).toBe(true);

    const modern = mockAudioActions('modern');
    const fallback = mockAudioActions('fallback');
    const result = audioTranslator(caps, { modern, fallback });

    expect(result).toBe(modern);
  });

  it('selects fallback on iOS 13 (below isolatedAudioFocus floor)', () => {
    const caps: Capabilities = probeCapabilities('ios', 13);
    expect(caps.isolatedAudioFocus).toBe(false);

    const modern = mockAudioActions('modern');
    const fallback = mockAudioActions('fallback');
    const result = audioTranslator(caps, { modern, fallback });

    expect(result).toBe(fallback);
  });
});

// ---------------------------------------------------------------------------
// foregroundServiceTranslator
// ---------------------------------------------------------------------------

describe('foregroundServiceTranslator', () => {
  it('selects modern path when foregroundServicePartialWakelock is true', () => {
    // Android 34 has foregroundServicePartialWakelock = true per OS_MATRIX
    const caps: Capabilities = probeCapabilities('android', 34);
    expect(caps.foregroundServicePartialWakelock).toBe(true);

    const modern = mockForegroundServiceActions('modern');
    const fallback = mockForegroundServiceActions('fallback');
    const result = foregroundServiceTranslator(caps, { modern, fallback });

    expect(result).toBe(modern);
  });

  it('selects fallback path when foregroundServicePartialWakelock is false', () => {
    // Android 33 is below the floor
    const caps: Capabilities = probeCapabilities('android', 33);
    expect(caps.foregroundServicePartialWakelock).toBe(false);

    const modern = mockForegroundServiceActions('modern');
    const fallback = mockForegroundServiceActions('fallback');
    const result = foregroundServiceTranslator(caps, { modern, fallback });

    expect(result).toBe(fallback);
  });

  it('always selects fallback on iOS (flag is platform-exclusive)', () => {
    // iOS has no foregroundServicePartialWakelock (minOsVersion: null)
    const caps: Capabilities = probeCapabilities('ios', 17);
    expect(caps.foregroundServicePartialWakelock).toBe(false);

    const modern = mockForegroundServiceActions('modern');
    const fallback = mockForegroundServiceActions('fallback');
    const result = foregroundServiceTranslator(caps, { modern, fallback });

    expect(result).toBe(fallback);
  });
});

// ---------------------------------------------------------------------------
// cryptoTranslator
// ---------------------------------------------------------------------------

describe('cryptoTranslator', () => {
  it('selects Secure Enclave modern path on iOS with secureEnclaveAvailable', () => {
    const caps: Capabilities = probeCapabilities('ios', 13);
    expect(caps.secureEnclaveAvailable).toBe(true);
    expect(caps.strongBoxAvailable).toBe(false);

    const seModern = mockCryptoActions('se-modern');
    const seFallback = mockCryptoActions('se-fallback');
    const sbModern = mockCryptoActions('sb-modern');
    const sbFallback = mockCryptoActions('sb-fallback');

    const result = cryptoTranslator(caps, {
      secureEnclave: { modern: seModern, fallback: seFallback },
      strongBox: { modern: sbModern, fallback: sbFallback },
    });

    expect(result).toBe(seModern);
  });

  it('selects StrongBox modern path on Android with strongBoxAvailable', () => {
    const caps: Capabilities = probeCapabilities('android', 29);
    expect(caps.secureEnclaveAvailable).toBe(false);
    expect(caps.strongBoxAvailable).toBe(true);

    const seModern = mockCryptoActions('se-modern');
    const seFallback = mockCryptoActions('se-fallback');
    const sbModern = mockCryptoActions('sb-modern');
    const sbFallback = mockCryptoActions('sb-fallback');

    const result = cryptoTranslator(caps, {
      secureEnclave: { modern: seModern, fallback: seFallback },
      strongBox: { modern: sbModern, fallback: sbFallback },
    });

    expect(result).toBe(sbModern);
  });

  it('selects fallback when neither secure element is available', () => {
    // Conservative baseline: both flags false
    const caps: Capabilities = defaultCapabilities();
    expect(caps.secureEnclaveAvailable).toBe(false);
    expect(caps.strongBoxAvailable).toBe(false);

    const seModern = mockCryptoActions('se-modern');
    const seFallback = mockCryptoActions('se-fallback');
    const sbModern = mockCryptoActions('sb-modern');
    const sbFallback = mockCryptoActions('sb-fallback');

    const result = cryptoTranslator(caps, {
      secureEnclave: { modern: seModern, fallback: seFallback },
      strongBox: { modern: sbModern, fallback: sbFallback },
    });

    // Falls back to the secureEnclave fallback (software-only path)
    expect(result).toBe(seFallback);
  });

  it('never selects both secure elements simultaneously', () => {
    // Per OS_MATRIX, secureEnclaveAvailable is iOS-only and
    // strongBoxAvailable is Android-only. They cannot both be true
    // from the matrix alone. Verify the translator handles the
    // (impossible but type-safe) case where both are true.
    const caps: Capabilities = probeCapabilities('ios', 13, {
      strongBoxAvailable: true, // hypothetical override
    });
    expect(caps.secureEnclaveAvailable).toBe(true);
    expect(caps.strongBoxAvailable).toBe(true);

    const seModern = mockCryptoActions('se-modern');
    const seFallback = mockCryptoActions('se-fallback');
    const sbModern = mockCryptoActions('sb-modern');
    const sbFallback = mockCryptoActions('sb-fallback');

    const result = cryptoTranslator(caps, {
      secureEnclave: { modern: seModern, fallback: seFallback },
      strongBox: { modern: sbModern, fallback: sbFallback },
    });

    // Secure Enclave takes priority (checked first)
    expect(result).toBe(seModern);
  });
});
