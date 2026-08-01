// extractNarrativeBody — strip leading YAML frontmatter from narrative markdown.
//
// Generated pack narratives may contain YAML frontmatter (poiId, language,
// tone metadata). This function removes exactly one leading frontmatter block
// after integrity verification so TourRuntime never speaks metadata aloud.
//
// Design:
// - Only the first block delimited by `---\n` ... `---\n` is stripped.
// - Supports both LF and CRLF line endings.
// - If no frontmatter is present, the input is returned unchanged (legacy packs).
// - Unterminated frontmatter (opening `---` without closing `---`) throws a
//   typed PackIntegrityError('invalid-content') — signed content that is
//   structurally broken is a publisher error.

import { PackIntegrityError } from './packIntegrity';

/**
 * Strip exactly one leading YAML frontmatter block from narrative markdown.
 *
 * @param text - The raw narrative text (post-integrity-verification).
 * @param relativePath - Asset relative path (for error context).
 * @returns The narrative body without frontmatter.
 * @throws PackIntegrityError with kind `invalid-content` if frontmatter is
 *   started but never terminated.
 */
export function extractNarrativeBody(text: string, relativePath: string): string {
  // Frontmatter must start at the very beginning of the file with `---`
  // followed by a newline (LF or CRLF).
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    // No frontmatter — return unchanged for legacy/authored content.
    return text;
  }

  // Find the closing `---` delimiter. It must appear on its own line.
  // We search starting after the opening delimiter line.
  const openLen = text.startsWith('---\r\n') ? 5 : 4;
  const closingIndex = findClosingFence(text, openLen);

  if (closingIndex === -1) {
    throw new PackIntegrityError(
      'invalid-content',
      relativePath,
      'unterminated YAML frontmatter: opening --- without closing ---',
    );
  }

  // The body starts after the closing `---` and its trailing newline.
  const afterClose = text.indexOf('\n', closingIndex);
  if (afterClose === -1) {
    // The closing `---` is the last line — body is empty.
    return '';
  }

  return text.slice(afterClose + 1);
}

/**
 * Find the byte offset of the closing `---` fence that appears on its own
 * line (possibly preceded by nothing, followed by `\n` or `\r\n` or EOF).
 */
function findClosingFence(text: string, startOffset: number): number {
  let pos = startOffset;
  while (pos < text.length) {
    // We are always at the start of a line here.
    if (
      text[pos] === '-' &&
      text[pos + 1] === '-' &&
      text[pos + 2] === '-' &&
      (pos + 3 >= text.length || text[pos + 3] === '\n' || text[pos + 3] === '\r')
    ) {
      return pos;
    }
    // Advance to the next line.
    const nl = text.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  return -1;
}
