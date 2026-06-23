// Unit tests for the small RFC 4180 CSV parser used by the GTFS reader.

import { parseCsv } from './csv';

function rowsAsObjects(
  rows: ReadonlyArray<ReadonlyMap<string, string>>,
): Array<Record<string, string>> {
  return rows.map((m) => Object.fromEntries(m.entries()));
}

describe('parseCsv', () => {
  it('parses a simple LF-terminated file', () => {
    const out = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(out.header).toEqual(['a', 'b', 'c']);
    expect(rowsAsObjects(out.rows)).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles CRLF line endings and a trailing blank line', () => {
    const out = parseCsv('h1,h2\r\nx,y\r\n\r\n');
    expect(out.header).toEqual(['h1', 'h2']);
    expect(rowsAsObjects(out.rows)).toEqual([{ h1: 'x', h2: 'y' }]);
  });

  it('strips a UTF-8 BOM', () => {
    const out = parseCsv('\ufeffname,age\nada,36\n');
    expect(out.header).toEqual(['name', 'age']);
    expect(rowsAsObjects(out.rows)).toEqual([{ name: 'ada', age: '36' }]);
  });

  it('handles quoted fields with commas, quotes, and newlines', () => {
    const csv = 'a,b\n"hello, world","line1\nline2"\n"escaped ""quote""",ok\n';
    const out = parseCsv(csv);
    expect(rowsAsObjects(out.rows)).toEqual([
      { a: 'hello, world', b: 'line1\nline2' },
      { a: 'escaped "quote"', b: 'ok' },
    ]);
  });

  it('throws on an unterminated quoted field', () => {
    expect(() => parseCsv('a,b\n"unterminated,oops\n')).toThrow(/unterminated/);
  });

  it('treats surplus columns as drop, missing columns as empty string', () => {
    const out = parseCsv('a,b\n1,2,3\n4\n');
    // Surplus column "3" is dropped; missing column for the second row maps to ''.
    expect(rowsAsObjects(out.rows)).toEqual([
      { a: '1', b: '2' },
      { a: '4', b: '' },
    ]);
  });

  it('returns empty header/rows for an empty input', () => {
    expect(parseCsv('')).toEqual({ header: [], rows: [] });
  });
});
