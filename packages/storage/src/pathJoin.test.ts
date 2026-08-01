import { assertSafePackRelativePath, pathJoin, UnsafePackPathError } from './pathJoin';

describe('assertSafePackRelativePath', () => {
  it('accepts normal pack-relative paths', () => {
    expect(() => assertSafePackRelativePath('narratives/poi.pl.md')).not.toThrow();
    expect(() => assertSafePackRelativePath('tiles/14/9000/5000.pbf')).not.toThrow();
  });

  it('rejects traversal and absolute paths', () => {
    expect(() => assertSafePackRelativePath('../etc/passwd')).toThrow(UnsafePackPathError);
    expect(() => assertSafePackRelativePath('/abs')).toThrow(UnsafePackPathError);
    expect(() => assertSafePackRelativePath('a/../../b')).toThrow(UnsafePackPathError);
    expect(() => assertSafePackRelativePath('')).toThrow(UnsafePackPathError);
  });
});

describe('pathJoin', () => {
  it('joins POSIX paths without duplicate separators', () => {
    expect(pathJoin('/data/docs/', '/packs/', 'bundle/1.0.0')).toBe(
      '/data/docs/packs/bundle/1.0.0',
    );
  });

  it('preserves the triple slash in Expo file URIs', () => {
    expect(pathJoin('file:///data/docs/', 'packs', 'bundle/1.0.0/audio/poi.m4a')).toBe(
      'file:///data/docs/packs/bundle/1.0.0/audio/poi.m4a',
    );
  });

  it('preserves non-file URI schemes', () => {
    expect(pathJoin('https://example.test/root/', '/asset.bin')).toBe(
      'https://example.test/root/asset.bin',
    );
  });
});
