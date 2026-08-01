// Unit tests for extractNarrativeBody — YAML frontmatter stripping.

import { extractNarrativeBody } from './extractNarrativeBody';
import { PackIntegrityError } from './packIntegrity';

describe('extractNarrativeBody', () => {
  it('returns unchanged text when no frontmatter is present', () => {
    const text = '# Welcome\nThis is a test narrative.';
    expect(extractNarrativeBody(text, 'narratives/poi.en.md')).toBe(text);
  });

  it('returns unchanged text for empty string', () => {
    expect(extractNarrativeBody('', 'test.md')).toBe('');
  });

  it('strips a valid YAML frontmatter block (LF)', () => {
    const text = '---\npoiId: poi-1\nlanguage: en\ntone: standard\n---\n# Welcome\nBody text.';
    expect(extractNarrativeBody(text, 'test.md')).toBe('# Welcome\nBody text.');
  });

  it('strips a valid YAML frontmatter block (CRLF)', () => {
    const text =
      '---\r\npoiId: poi-1\r\nlanguage: en\r\ntone: standard\r\n---\r\n# Welcome\r\nBody text.';
    expect(extractNarrativeBody(text, 'test.md')).toBe('# Welcome\r\nBody text.');
  });

  it('handles frontmatter with empty body', () => {
    const text = '---\npoiId: poi-1\n---\n';
    expect(extractNarrativeBody(text, 'test.md')).toBe('');
  });

  it('handles frontmatter where closing --- is the last line without trailing newline', () => {
    const text = '---\npoiId: poi-1\n---';
    expect(extractNarrativeBody(text, 'test.md')).toBe('');
  });

  it('only strips the first frontmatter block', () => {
    const text = '---\nfirst: block\n---\n# Title\n---\nsecond: block\n---\nMore text.';
    expect(extractNarrativeBody(text, 'test.md')).toBe(
      '# Title\n---\nsecond: block\n---\nMore text.',
    );
  });

  it('preserves markdown content after frontmatter', () => {
    const text = '---\ntone: memorial\n---\n## Heading\n\n- Item 1\n- Item 2\n\n> Quote';
    expect(extractNarrativeBody(text, 'test.md')).toBe(
      '## Heading\n\n- Item 1\n- Item 2\n\n> Quote',
    );
  });

  it('throws PackIntegrityError for unterminated frontmatter', () => {
    const text = '---\npoiId: poi-1\nlanguage: en\nThis never closes';
    expect(() => extractNarrativeBody(text, 'narratives/poi.en.md')).toThrow(PackIntegrityError);
    try {
      extractNarrativeBody(text, 'narratives/poi.en.md');
    } catch (e) {
      expect((e as PackIntegrityError).kind).toBe('invalid-content');
      expect((e as PackIntegrityError).relativePath).toBe('narratives/poi.en.md');
    }
  });

  it('does not treat --- in the middle of text as frontmatter', () => {
    const text = 'Some intro text.\n---\npoiId: poi-1\n---\nMore text.';
    // Does not start with ---, so no frontmatter stripping.
    expect(extractNarrativeBody(text, 'test.md')).toBe(text);
  });

  it('handles text that starts with --- but has no newline after', () => {
    const text = '---something';
    // Not valid frontmatter (no newline after ---).
    expect(extractNarrativeBody(text, 'test.md')).toBe(text);
  });

  it('handles empty frontmatter block (only delimiters)', () => {
    const text = '---\n---\n# Body';
    expect(extractNarrativeBody(text, 'test.md')).toBe('# Body');
  });

  it('preserves content with dashes in markdown', () => {
    const text = '---\ntone: standard\n---\n# Title\n\nSome text with --- dashes inside.';
    expect(extractNarrativeBody(text, 'test.md')).toBe(
      '# Title\n\nSome text with --- dashes inside.',
    );
  });
});
