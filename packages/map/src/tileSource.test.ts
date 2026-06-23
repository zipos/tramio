/**
 * Unit tests for the offline tile source resolver.
 *
 * Validates:
 * - Correct file:// URL generation for valid pack references
 * - Path traversal rejection for malformed bundleId/version
 * - buildOfflineStyle produces a valid MapLibre style with no external URLs
 *
 * @see Requirements 3.2, 4.1, 4.4
 */

import { resolveOfflineTileSource, buildOfflineStyle } from './tileSource';

describe('resolveOfflineTileSource', () => {
  it('resolves a valid tile pack to a file:// URL template', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: 'wroclaw-tram-7-east',
      version: '1.4.2',
    });

    expect(result.valid).toBe(true);
    expect(result.tileUrl).toBe(
      'file:///data/docs/packs/wroclaw-tram-7-east/1.4.2/tiles/{z}/{x}/{y}.pbf',
    );
  });

  it('strips trailing slashes from docsDir', () => {
    const result = resolveOfflineTileSource('/data/docs/', {
      bundleId: 'bundle-a',
      version: '2.0.0',
    });

    expect(result.valid).toBe(true);
    expect(result.tileUrl).toBe(
      'file:///data/docs/packs/bundle-a/2.0.0/tiles/{z}/{x}/{y}.pbf',
    );
  });

  it('strips multiple trailing slashes from docsDir', () => {
    const result = resolveOfflineTileSource('/data/docs///', {
      bundleId: 'bundle-a',
      version: '1.0.0',
    });

    expect(result.valid).toBe(true);
    expect(result.tileUrl).toContain('file:///data/docs/packs/bundle-a/1.0.0/tiles/');
  });

  it('rejects empty docsDir', () => {
    const result = resolveOfflineTileSource('', {
      bundleId: 'bundle-a',
      version: '1.0.0',
    });

    expect(result.valid).toBe(false);
    expect(result.tileUrl).toBe('');
  });

  it('rejects empty bundleId', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: '',
      version: '1.0.0',
    });

    expect(result.valid).toBe(false);
    expect(result.tileUrl).toBe('');
  });

  it('rejects empty version', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: 'bundle-a',
      version: '',
    });

    expect(result.valid).toBe(false);
    expect(result.tileUrl).toBe('');
  });

  it('rejects bundleId with path separator (forward slash)', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: '../escape',
      version: '1.0.0',
    });

    expect(result.valid).toBe(false);
  });

  it('rejects bundleId with backslash', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: 'foo\\bar',
      version: '1.0.0',
    });

    expect(result.valid).toBe(false);
  });

  it('rejects version with path separator', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: 'bundle-a',
      version: '1.0/../../etc',
    });

    expect(result.valid).toBe(false);
  });

  it('rejects bundleId that is "."', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: '.',
      version: '1.0.0',
    });

    expect(result.valid).toBe(false);
  });

  it('rejects bundleId that is ".."', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: '..',
      version: '1.0.0',
    });

    expect(result.valid).toBe(false);
  });

  it('rejects version containing null byte', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: 'bundle-a',
      version: '1.0\u0000.0',
    });

    expect(result.valid).toBe(false);
  });

  it('accepts bundleId with hyphens and dots', () => {
    const result = resolveOfflineTileSource('/data/docs', {
      bundleId: 'city-tram.line-7.east',
      version: '1.4.2-beta.1',
    });

    expect(result.valid).toBe(true);
    expect(result.tileUrl).toContain('city-tram.line-7.east');
    expect(result.tileUrl).toContain('1.4.2-beta.1');
  });
});

describe('buildOfflineStyle', () => {
  const tileUrl = 'file:///data/docs/packs/bundle-a/1.0.0/tiles/{z}/{x}/{y}.pbf';

  it('returns a valid MapLibre style object with version 8', () => {
    const style = buildOfflineStyle(tileUrl);
    expect(style.version).toBe(8);
  });

  it('includes an offline-tiles vector source', () => {
    const style = buildOfflineStyle(tileUrl);
    const sources = style.sources as Record<string, unknown>;
    expect(sources['offline-tiles']).toBeDefined();

    const source = sources['offline-tiles'] as Record<string, unknown>;
    expect(source.type).toBe('vector');
    expect(source.tiles).toEqual([tileUrl]);
  });

  it('uses only the provided file:// URL (no external URLs)', () => {
    const style = buildOfflineStyle(tileUrl);
    const json = JSON.stringify(style);

    // Must not contain any http:// or https:// URLs
    expect(json).not.toMatch(/https?:\/\//);
    // Must not reference Google Maps, Apple MapKit, or Mapbox
    expect(json).not.toMatch(/google/i);
    expect(json).not.toMatch(/mapkit/i);
    expect(json).not.toMatch(/mapbox/i);
  });

  it('includes at least one layer', () => {
    const style = buildOfflineStyle(tileUrl);
    const layers = style.layers as unknown[];
    expect(layers.length).toBeGreaterThan(0);
  });

  it('includes a background layer', () => {
    const style = buildOfflineStyle(tileUrl);
    const layers = style.layers as Array<{ id: string; type: string }>;
    const bg = layers.find((l) => l.id === 'background');
    expect(bg).toBeDefined();
    expect(bg?.type).toBe('background');
  });
});
