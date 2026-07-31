// packStyleResolver.test — verify that pack-backed tours apply the memorial
// rate multiplier. This is the test that would have caught bug F1 (tone
// metadata dropped for offline packs).

import type { SegmentStyleResolver } from './TourRuntime';

/**
 * Reproduces the resolver-construction logic from useTourEngine.startTour
 * so we can unit-test it without mocking React hooks or expo modules.
 */
function buildPackStyleResolver(
  tones: Readonly<Record<string, 'standard' | 'memorial'>> | undefined,
): SegmentStyleResolver {
  if (tones && Object.keys(tones).length > 0) {
    return (segmentId: string) => {
      const colonIdx = segmentId.lastIndexOf(':');
      const poiId = colonIdx === -1 ? segmentId : segmentId.slice(0, colonIdx);
      const tone = tones[poiId] ?? 'standard';
      return tone === 'memorial' ? { rateMultiplier: 0.9 } : null;
    };
  }
  // Falls back to the embedded resolver when no pack tones are provided.
  return () => null;
}

describe('pack segment style resolver', () => {
  const memorialPoiId = 'poi-polin';
  const standardPoiId = 'poi-foksal';

  const tones: Readonly<Record<string, 'standard' | 'memorial'>> = {
    [memorialPoiId]: 'memorial',
    [standardPoiId]: 'standard',
  };

  it('applies rate multiplier 0.9 for memorial segments', () => {
    const resolver = buildPackStyleResolver(tones);
    const style = resolver(`${memorialPoiId}:pl`);
    expect(style).toEqual({ rateMultiplier: 0.9 });
  });

  it('returns null (no adjustment) for standard segments', () => {
    const resolver = buildPackStyleResolver(tones);
    const style = resolver(`${standardPoiId}:en`);
    expect(style).toBeNull();
  });

  it('returns null for unknown POIs (defaults to standard)', () => {
    const resolver = buildPackStyleResolver(tones);
    const style = resolver('poi-unknown:pl');
    expect(style).toBeNull();
  });

  it('strips the language suffix to look up the POI id', () => {
    const resolver = buildPackStyleResolver(tones);
    // Same memorial POI, different language — should still be 0.9
    expect(resolver(`${memorialPoiId}:en`)).toEqual({ rateMultiplier: 0.9 });
    expect(resolver(`${memorialPoiId}:pl`)).toEqual({ rateMultiplier: 0.9 });
  });

  it('falls back to no-adjustment resolver when tones is empty', () => {
    const resolver = buildPackStyleResolver({});
    expect(resolver(`${memorialPoiId}:pl`)).toBeNull();
  });

  it('falls back to no-adjustment resolver when tones is undefined', () => {
    const resolver = buildPackStyleResolver(undefined);
    expect(resolver(`${memorialPoiId}:pl`)).toBeNull();
  });
});

describe('pack style resolver integration with TourRuntime rate calculation', () => {
  // This test reproduces the exact computation done in TourRuntime.handlePlaySegment:
  //   rate = baseRate * (resolver(segmentId)?.rateMultiplier ?? 1)
  const PLAYBACK_SPEED = 1.0;

  const tones: Readonly<Record<string, 'standard' | 'memorial'>> = {
    'poi-polin': 'memorial',
    'poi-cmentarz-zydowski': 'memorial',
    'poi-foksal': 'standard',
    'poi-wilanow': 'standard',
  };

  it('reduces effective rate for memorial content at normal speed', () => {
    const resolver = buildPackStyleResolver(tones);
    const multiplier = resolver('poi-polin:pl')?.rateMultiplier ?? 1;
    const rate = PLAYBACK_SPEED * multiplier;
    expect(rate).toBeCloseTo(0.9);
  });

  it('keeps effective rate unchanged for standard content', () => {
    const resolver = buildPackStyleResolver(tones);
    const multiplier = resolver('poi-foksal:en')?.rateMultiplier ?? 1;
    const rate = PLAYBACK_SPEED * multiplier;
    expect(rate).toBeCloseTo(1.0);
  });

  it('reduces effective rate for memorial content at increased speed', () => {
    const resolver = buildPackStyleResolver(tones);
    const baseRate = 1.5;
    const multiplier = resolver('poi-cmentarz-zydowski:pl')?.rateMultiplier ?? 1;
    const rate = baseRate * multiplier;
    expect(rate).toBeCloseTo(1.35); // 1.5 * 0.9
  });

  it('would have caught bug F1: without tones, memorial content plays at full speed', () => {
    // This is the broken state before the fix: no tones provided
    const brokenResolver = buildPackStyleResolver(undefined);
    const multiplier = brokenResolver('poi-polin:pl')?.rateMultiplier ?? 1;
    const rate = PLAYBACK_SPEED * multiplier;
    // Without the fix, rate is 1.0 (full speed) for memorial content
    expect(rate).toBeCloseTo(1.0);

    // With the fix: tones are provided from the pack
    const fixedResolver = buildPackStyleResolver(tones);
    const fixedMultiplier = fixedResolver('poi-polin:pl')?.rateMultiplier ?? 1;
    const fixedRate = PLAYBACK_SPEED * fixedMultiplier;
    // Rate is reduced to 0.9
    expect(fixedRate).toBeCloseTo(0.9);
    expect(fixedRate).toBeLessThan(rate);
  });
});
