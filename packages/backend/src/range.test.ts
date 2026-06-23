import { parseRange } from './range';

describe('parseRange', () => {
  test('returns absent when no header', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'absent' });
    expect(parseRange('', 100)).toEqual({ kind: 'absent' });
  });

  test('parses a closed range', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ kind: 'satisfiable', start: 0, end: 9 });
  });

  test('parses an open-ended range', () => {
    expect(parseRange('bytes=50-', 100)).toEqual({ kind: 'satisfiable', start: 50, end: 99 });
  });

  test('parses a suffix range', () => {
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'satisfiable', start: 90, end: 99 });
  });

  test('clamps end to total size', () => {
    expect(parseRange('bytes=0-999', 100)).toEqual({ kind: 'satisfiable', start: 0, end: 99 });
  });

  test('returns unsatisfiable for malformed or out-of-range', () => {
    expect(parseRange('chunks=0-9', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=10-5', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=200-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=0-9', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
