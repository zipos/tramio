/**
 * Smoke unit tests for the flag-driven dispatch helper (task 9.2).
 *
 * Required assertions per the task brief:
 *   - `dispatchByCapability` selects modern when flag true.
 *   - `dispatchByCapability` selects fallback when flag false.
 */

import { defaultCapabilities, dispatchByCapability, probeCapabilities } from './index';
import type { Capabilities } from './types';

describe('dispatchByCapability', () => {
  it('selects the modern variant when the flag is true', () => {
    // probeCapabilities('android', 31) puts isolatedAudioFocus = true per
    // the OS_MATRIX floor. Use that real flag value rather than a hand-rolled
    // record so we exercise the actual production code path.
    const caps: Capabilities = probeCapabilities('android', 31);
    expect(caps.isolatedAudioFocus).toBe(true);

    const picked = dispatchByCapability(caps, {
      isolatedAudioFocus: { modern: 'modern-path', fallback: 'fallback-path' },
    });

    expect(picked).toBe('modern-path');
  });

  it('selects the fallback variant when the flag is false', () => {
    // The conservative baseline has every flag false, so any single-flag
    // mapping must resolve to its fallback variant.
    const caps: Capabilities = defaultCapabilities();
    expect(caps.regionMonitoringV2).toBe(false);

    const picked = dispatchByCapability(caps, {
      regionMonitoringV2: { modern: 'v2', fallback: 'legacy' },
    });

    expect(picked).toBe('legacy');
  });

  it('throws when the mapping is empty', () => {
    const caps: Capabilities = defaultCapabilities();
    expect(() => dispatchByCapability(caps, {})).toThrow(/exactly one capability flag/);
  });

  it('throws when the mapping declares more than one flag', () => {
    const caps: Capabilities = defaultCapabilities();
    expect(() =>
      dispatchByCapability(caps, {
        regionMonitoringV2: { modern: 'a', fallback: 'b' },
        isolatedAudioFocus: { modern: 'c', fallback: 'd' },
      }),
    ).toThrow(/exactly one capability flag/);
  });

  it('preserves the variant value verbatim (works for non-string T too)', () => {
    // The helper is generic; non-string variants (functions, objects) round-trip
    // unchanged so command translators can return native call thunks.
    const modernThunk = (): string => 'modern';
    const fallbackThunk = (): string => 'fallback';

    const caps: Capabilities = probeCapabilities('android', 31);
    const picked = dispatchByCapability(caps, {
      isolatedAudioFocus: { modern: modernThunk, fallback: fallbackThunk },
    });

    expect(picked).toBe(modernThunk);
    expect(picked()).toBe('modern');
  });
});
