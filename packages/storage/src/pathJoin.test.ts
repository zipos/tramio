import { assertSafePackRelativePath, UnsafePackPathError } from './pathJoin';

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
