// Minimal RFC 4180 CSV parser.
//
// GTFS CSV files follow RFC 4180: comma-separated, optional CRLF/LF row
// terminators, double-quoted fields when a comma, quote, or newline appears
// in the value, and `""` to escape a quote inside a quoted field. UTF-8 BOM
// is allowed at the very start of a file.
//
// We roll our own rather than pulling in `papaparse`/`csv-parse` because:
//   - GTFS is a tiny grammar with no quoting tricks beyond what RFC 4180
//     specifies (no exotic delimiters, no comment rows).
//   - Avoiding the dep keeps `@tramio/storage` a zero-runtime-deps package
//     (matching `package.json`).
//   - The parser is maybe 80 lines and the only consumer is this module.
//
// The function returns an array of rows where each row is an object keyed
// by header name. Missing columns yield `undefined`. Surplus columns in a
// row are dropped. Empty trailing newlines are ignored.

export interface ParsedCsv {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyMap<string, string>>;
}

/**
 * Parse a CSV string into a header + row sequence. Throws on a structurally
 * invalid file (e.g., unterminated quoted field). The header row is
 * required; an input that contains no rows at all yields `header: []` and
 * `rows: []`.
 */
export function parseCsv(input: string): ParsedCsv {
  // Strip UTF-8 BOM if present.
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records = tokenizeRecords(src);
  if (records.length === 0) {
    return { header: [], rows: [] };
  }
  const header = records[0] as ReadonlyArray<string>;
  const trimmedHeader = header.map((h) => h.trim());
  const rows: ReadonlyMap<string, string>[] = [];
  for (let i = 1; i < records.length; i++) {
    const row = records[i] as ReadonlyArray<string>;
    // GTFS feeds commonly contain a final blank line. Skip rows that are a
    // single empty cell.
    if (row.length === 1 && row[0] === '') continue;
    const map = new Map<string, string>();
    for (let j = 0; j < trimmedHeader.length; j++) {
      const key = trimmedHeader[j] as string;
      const val = j < row.length ? (row[j] as string) : '';
      map.set(key, val);
    }
    rows.push(map);
  }
  return { header: trimmedHeader, rows };
}

/**
 * Lex `src` into records. Each record is an array of field strings. Quoted
 * fields are unquoted and `""` is collapsed to `"`. Newlines are LF, CR,
 * or CRLF.
 */
function tokenizeRecords(src: string): ReadonlyArray<ReadonlyArray<string>> {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = src.length;

  while (i < n) {
    const c = src.charCodeAt(i);
    if (inQuotes) {
      if (c === 0x22 /* " */) {
        if (i + 1 < n && src.charCodeAt(i + 1) === 0x22) {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        // End of quoted field.
        inQuotes = false;
        i += 1;
        continue;
      }
      field += src[i];
      i += 1;
      continue;
    }

    // Not in quotes.
    if (c === 0x22 /* " */) {
      // RFC 4180: a quote at the start of a field begins a quoted field.
      // GTFS feeds in the wild sometimes embed a stray quote mid-field;
      // treat anything else as a literal character to be lenient.
      if (field.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      field += '"';
      i += 1;
      continue;
    }
    if (c === 0x2c /* , */) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === 0x0a /* \n */) {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (c === 0x0d /* \r */) {
      row.push(field);
      records.push(row);
      row = [];
      field = '';
      // Swallow following \n so CRLF is one separator, not two.
      if (i + 1 < n && src.charCodeAt(i + 1) === 0x0a) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    field += src[i];
    i += 1;
  }

  if (inQuotes) {
    throw new Error('CSV: unterminated quoted field');
  }

  // Flush trailing partial record. Empty trailing record (file ended on a
  // newline) is filtered by the row==[''] check in `parseCsv`.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }

  return records;
}
