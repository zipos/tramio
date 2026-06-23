// Markdown YAML-frontmatter parser used by the Content_Bundle validator.
//
// We deliberately keep this tiny rather than pulling a full YAML parser
// into the authoring package: the narrative frontmatter shape is closed
// (declared in `narrativeFrontmatter` JSON Schema) and consists of
// simple scalars, an optional list-of-maps for `licenses`, and a small
// fixed set of keys. The parser supports exactly that shape.
//
// Supported syntax:
//
//   ---
//   poiId: poi-rynek
//   language: pl
//   durationHintSec: 45
//   sponsor: null
//   disclosure: 'Sponsored by Cafe Zamek.'
//   tier: b2b
//   licenses:
//     - id: CC-BY-4.0
//       attribution: 'Photo and text adapted from Wikipedia'
//   ---
//
// `body` is whatever follows the closing `---` (possibly empty).
//
// On unrecognised syntax the parser returns a `ParseError` with a
// best-effort line number.

export interface FrontmatterParseSuccess {
  readonly ok: true;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

export interface FrontmatterParseFailure {
  readonly ok: false;
  readonly message: string;
}

export type FrontmatterParseResult = FrontmatterParseSuccess | FrontmatterParseFailure;

const FRONTMATTER_FENCE = /^---\s*$/;

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(rawValue: string): unknown {
  const v = rawValue.trim();
  if (v === '' || v === '~') return null;
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Quoted strings preserve their content verbatim (sans quotes).
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return stripQuotes(v);
  }
  // Numbers (int or float).
  if (/^-?\d+$/.test(v)) {
    return Number.parseInt(v, 10);
  }
  if (/^-?\d+\.\d+$/.test(v)) {
    return Number.parseFloat(v);
  }
  return v;
}

interface KeyValueLine {
  readonly indent: number;
  readonly key: string;
  readonly inlineValue: string | undefined;
}

interface ListItemLine {
  readonly indent: number;
  /** First key on the item line (e.g. `id` for `- id: CC-BY-4.0`). */
  readonly firstKey: string;
  readonly firstValue: string;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i += 1;
  return i;
}

function tryParseKeyValue(line: string): KeyValueLine | null {
  const indent = indentOf(line);
  const rest = line.slice(indent);
  if (rest.startsWith('-') || rest.startsWith('#') || rest.length === 0) return null;
  const colonIdx = rest.indexOf(':');
  if (colonIdx < 0) return null;
  const key = rest.slice(0, colonIdx).trim();
  if (key.length === 0) return null;
  const after = rest.slice(colonIdx + 1);
  const inlineValue = after.trim();
  return {
    indent,
    key,
    inlineValue: inlineValue.length > 0 ? inlineValue : undefined,
  };
}

function tryParseListItem(line: string): ListItemLine | null {
  const indent = indentOf(line);
  const rest = line.slice(indent);
  if (!rest.startsWith('- ')) return null;
  const after = rest.slice(2);
  const colonIdx = after.indexOf(':');
  if (colonIdx < 0) return null;
  const firstKey = after.slice(0, colonIdx).trim();
  const firstValue = after.slice(colonIdx + 1).trim();
  return { indent, firstKey, firstValue };
}

function parseFrontmatterBlock(block: string[]): FrontmatterParseResult {
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < block.length) {
    const raw = block[i] ?? '';
    if (raw.trim().length === 0 || raw.trim().startsWith('#')) {
      i += 1;
      continue;
    }
    const kv = tryParseKeyValue(raw);
    if (!kv || kv.indent !== 0) {
      return {
        ok: false,
        message: `Unrecognised frontmatter syntax at line ${i + 1}: "${raw}"`,
      };
    }

    if (kv.inlineValue !== undefined) {
      out[kv.key] = parseScalar(kv.inlineValue);
      i += 1;
      continue;
    }

    // Multi-line value: must be a list-of-maps (the only nested shape
    // narrative frontmatter uses, for `licenses`).
    i += 1;
    const items: Record<string, unknown>[] = [];
    let listIndent: number | null = null;

    while (i < block.length) {
      const peek = block[i] ?? '';
      if (peek.trim().length === 0) {
        i += 1;
        continue;
      }
      const item = tryParseListItem(peek);
      if (!item) break;
      if (listIndent === null) listIndent = item.indent;
      else if (item.indent !== listIndent) {
        return {
          ok: false,
          message: `Inconsistent list indentation at line ${i + 1}: "${peek}"`,
        };
      }

      const obj: Record<string, unknown> = {};
      obj[item.firstKey] = parseScalar(item.firstValue);
      i += 1;

      // Subsequent lines belonging to the same list item must be
      // indented strictly deeper than the dash itself.
      const continuationIndent = listIndent + 2;
      while (i < block.length) {
        const cont = block[i] ?? '';
        if (cont.trim().length === 0) {
          i += 1;
          continue;
        }
        const contKv = tryParseKeyValue(cont);
        if (!contKv) break;
        if (contKv.indent < continuationIndent) break;
        if (contKv.inlineValue === undefined) {
          return {
            ok: false,
            message: `Nested-mapping is unsupported at line ${i + 1}`,
          };
        }
        obj[contKv.key] = parseScalar(contKv.inlineValue);
        i += 1;
      }
      items.push(obj);
    }

    out[kv.key] = items;
  }

  return { ok: true, frontmatter: out, body: '' };
}

/**
 * Split a Markdown file into its YAML frontmatter and body. If the file
 * does not open with a `---` fence on the first non-empty line, returns
 * an empty frontmatter with the entire file as `body`.
 */
export function parseFrontmatter(source: string): FrontmatterParseResult {
  const lines = source.split(/\r?\n/);

  // Skip leading blank lines but require the first non-blank line to be
  // the opening fence; otherwise treat the whole file as body with no
  // frontmatter (the schema validator will catch missing required keys).
  let firstNonBlank = 0;
  while (firstNonBlank < lines.length && lines[firstNonBlank]?.trim().length === 0) {
    firstNonBlank += 1;
  }
  if (firstNonBlank >= lines.length || !FRONTMATTER_FENCE.test(lines[firstNonBlank] ?? '')) {
    return { ok: true, frontmatter: {}, body: source };
  }

  const startIdx = firstNonBlank + 1;
  let endIdx = -1;
  for (let i = startIdx; i < lines.length; i += 1) {
    if (FRONTMATTER_FENCE.test(lines[i] ?? '')) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return {
      ok: false,
      message: 'Unterminated frontmatter block (no closing `---`).',
    };
  }

  const block = lines.slice(startIdx, endIdx);
  const parsed = parseFrontmatterBlock(block);
  if (!parsed.ok) return parsed;

  const body = lines.slice(endIdx + 1).join('\n');
  return { ok: true, frontmatter: parsed.frontmatter, body };
}
