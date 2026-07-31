// Review-gate validation tests.
//
// Covers the review-gate rules added for the AI content-authoring pipeline:
//   - refuted claims always fail (all modes)
//   - confirmed claims without sourceUrl always fail
//   - unchecked claims fail in strict mode only
//   - unverifiable claims fail in strict mode only
//   - unapproved review fails in strict mode only
//   - tone 'memorial' segments must not be empty
//   - pass cases for all rules

import * as fc from 'fast-check';
import { validateBundle } from './validate';
import { virtualFileSystem } from './fs';
import type { Manifest, Pois, Route } from '../types';
import type { BundleValidationError, HintCode } from './types';

// ---------------------------------------------------------------------------
// Canonical valid bundle builder
// ---------------------------------------------------------------------------

type MutableBundle = Record<string, string | Buffer>;

const validManifest: Manifest = {
  bundleId: 'warsaw-bus-180',
  version: '1.0.0',
  city: { id: 'warsaw', country: 'PL' },
  transitLine: { gtfsRouteId: '180', direction: 'north', agency: 'ZTM' },
  languages: ['pl'],
  defaultLanguage: 'pl',
  minAppVersion: '1.0.0',
  deadReckoning: { permitted: true, maxLeadSeconds: 30 },
  standbyTracks: [],
  attribution: [{ kind: 'osm' }],
  checksumAlgorithm: 'sha256',
};

const validRoute: Route = {
  bundleId: 'warsaw-bus-180',
  polyline: [
    [52.23, 21.01],
    [52.24, 21.02],
  ],
  stops: [
    { id: 'stop-001', gtfsStopId: '5001', coord: [52.23, 21.01], scheduledOffsetSec: 0 },
    { id: 'stop-002', gtfsStopId: '5002', coord: [52.24, 21.02], scheduledOffsetSec: 120 },
  ],
  deviationCorridorMeters: 100,
};

const validPois: Pois = {
  pois: [
    {
      id: 'poi-cemetery',
      category: 'landmark',
      priority: 80,
      geometry: { kind: 'circle', center: [52.235, 21.015], radiusMeters: 50 },
      dwellSec: 3,
      deferrable: true,
      drPermitted: true,
      tier: 'free',
      narratives: { pl: 'narratives/poi-cemetery.pl.md' },
    },
  ],
};

function makeNarrative(opts: {
  claims?: string;
  review?: string;
  tone?: string;
  body?: string;
}): string {
  const lines: string[] = ['---', 'poiId: poi-cemetery', 'language: pl'];
  if (opts.tone) lines.push(`tone: ${opts.tone}`);
  if (opts.claims) lines.push(`claims:`, ...opts.claims.split('\n').map((l) => `${l}`));
  if (opts.review) lines.push(`review:`, ...opts.review.split('\n').map((l) => `${l}`));
  lines.push('---', '');
  if (opts.body !== undefined) {
    lines.push(opts.body);
  } else {
    lines.push('# Cemetery wall', '', 'The wall runs along Okopowa Street.');
  }
  return lines.join('\n');
}

function buildValidBundle(narrativeContent?: string): MutableBundle {
  return {
    'manifest.json': JSON.stringify(validManifest),
    'route.json': JSON.stringify(validRoute),
    'pois.json': JSON.stringify(validPois),
    'narratives/poi-cemetery.pl.md':
      narrativeContent ??
      makeNarrative({
        claims: `  - id: claim-1\n    text: "The wall is a historic boundary."\n    verdict: confirmed\n    sourceUrl: https://example.com/source`,
        review: `  reviewedBy: jan.kowalski\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function expectRejected(
  bundle: MutableBundle,
  opts?: { strict?: boolean },
): readonly BundleValidationError[] {
  const result = validateBundle(
    virtualFileSystem(bundle),
    opts?.strict === true ? { strict: true } : undefined,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected validation to fail');
  return result.errors;
}

function expectAccepted(bundle: MutableBundle, opts?: { strict?: boolean }): void {
  const result = validateBundle(
    virtualFileSystem(bundle),
    opts?.strict === true ? { strict: true } : undefined,
  );
  if (!result.ok) {
    throw new Error(
      `Expected ok, got errors:\n${result.errors
        .map((e) => `  [${e.hint.code}] ${e.filePath} ${e.jsonPointer}: ${e.message}`)
        .join('\n')}`,
    );
  }
  expect(result.ok).toBe(true);
}

function findByHintCode(
  errors: readonly BundleValidationError[],
  code: HintCode,
): BundleValidationError | undefined {
  return errors.find((e) => e.hint.code === code);
}

// ---------------------------------------------------------------------------
// Tests — Pass cases
// ---------------------------------------------------------------------------

describe('Review gate — pass cases', () => {
  it('accepts a bundle with no claims, no review, no tone (backward compat)', () => {
    const bundle = buildValidBundle(makeNarrative({}));
    expectAccepted(bundle);
  });

  it('accepts a bundle with no claims, no review, no tone in strict mode when review is approved', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        review: `  reviewedBy: anna\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
    );
    expectAccepted(bundle, { strict: true });
  });

  it('accepts a bundle with all claims confirmed and sourceUrl present', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "Fact A"\n    verdict: confirmed\n    sourceUrl: https://example.com/a`,
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
    );
    expectAccepted(bundle, { strict: true });
  });

  it('accepts a bundle with tone standard and non-empty body', () => {
    const bundle = buildValidBundle(makeNarrative({ tone: 'standard' }));
    expectAccepted(bundle);
  });

  it('accepts a bundle with tone memorial and non-empty body', () => {
    const bundle = buildValidBundle(
      makeNarrative({ tone: 'memorial', body: '# Memorial\n\nContent here.' }),
    );
    expectAccepted(bundle);
  });

  it('accepts in non-strict mode even if review.decision is pending', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: pending`,
      }),
    );
    expectAccepted(bundle);
  });

  it('accepts in non-strict mode even if there are unchecked claims', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "Some fact"\n    verdict: unchecked`,
      }),
    );
    expectAccepted(bundle);
  });

  it('accepts in non-strict mode even if there are unverifiable claims', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "Some fact"\n    verdict: unverifiable`,
      }),
    );
    expectAccepted(bundle);
  });
});

// ---------------------------------------------------------------------------
// Tests — Refuted claim (always fails)
// ---------------------------------------------------------------------------

describe('Review gate — refuted claim (all modes)', () => {
  it('rejects a bundle with a refuted claim in default mode', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: ghetto-wall\n    text: "This is a Warsaw Ghetto wall"\n    verdict: refuted`,
      }),
    );
    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'refuted-claim');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-cemetery.pl.md');
    expect(e!.jsonPointer).toBe('/claims/0/verdict');
    expect(e!.message).toMatch(/refuted/i);
    expect(e!.message).toMatch(/ghetto-wall/);
  });

  it('rejects a bundle with a refuted claim in strict mode', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: ghetto-wall\n    text: "This is a Warsaw Ghetto wall"\n    verdict: refuted`,
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
    );
    const errors = expectRejected(bundle, { strict: true });
    const e = findByHintCode(errors, 'refuted-claim');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-cemetery.pl.md');
    expect(e!.jsonPointer).toBe('/claims/0/verdict');
  });

  it('rejects when only one of multiple claims is refuted', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: [
          '  - id: c1',
          '    text: "True fact"',
          '    verdict: confirmed',
          '    sourceUrl: https://example.com',
          '  - id: c2',
          '    text: "False fact"',
          '    verdict: refuted',
        ].join('\n'),
      }),
    );
    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'refuted-claim');
    expect(e).toBeDefined();
    expect(e!.jsonPointer).toBe('/claims/1/verdict');
  });
});

// ---------------------------------------------------------------------------
// Tests — Confirmed claim missing sourceUrl (always fails)
// ---------------------------------------------------------------------------

describe('Review gate — confirmed claim missing sourceUrl', () => {
  it('rejects a confirmed claim without sourceUrl in default mode', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "A confirmed fact"\n    verdict: confirmed`,
      }),
    );
    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'confirmed-claim-missing-source');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-cemetery.pl.md');
    expect(e!.jsonPointer).toBe('/claims/0/sourceUrl');
    expect(e!.message).toMatch(/sourceUrl/);
  });

  it('rejects a confirmed claim without sourceUrl in strict mode', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "A confirmed fact"\n    verdict: confirmed`,
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
    );
    const errors = expectRejected(bundle, { strict: true });
    const e = findByHintCode(errors, 'confirmed-claim-missing-source');
    expect(e).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests — Unchecked claim (strict only)
// ---------------------------------------------------------------------------

describe('Review gate — unchecked claim (strict mode only)', () => {
  it('passes in default mode with an unchecked claim', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "Unchecked fact"\n    verdict: unchecked`,
      }),
    );
    expectAccepted(bundle);
  });

  it('rejects in strict mode with an unchecked claim', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "Unchecked fact"\n    verdict: unchecked`,
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
    );
    const errors = expectRejected(bundle, { strict: true });
    const e = findByHintCode(errors, 'unchecked-claim');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-cemetery.pl.md');
    expect(e!.jsonPointer).toBe('/claims/0/verdict');
    expect(e!.message).toMatch(/unchecked/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — Unverifiable claim (strict only)
// ---------------------------------------------------------------------------

describe('Review gate — unverifiable claim (strict mode only)', () => {
  it('passes in default mode with an unverifiable claim', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "Unverifiable fact"\n    verdict: unverifiable`,
      }),
    );
    expectAccepted(bundle);
  });

  it('rejects in strict mode with an unverifiable claim', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        claims: `  - id: c1\n    text: "Unverifiable fact"\n    verdict: unverifiable`,
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
    );
    const errors = expectRejected(bundle, { strict: true });
    const e = findByHintCode(errors, 'unverifiable-claim');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-cemetery.pl.md');
    expect(e!.jsonPointer).toBe('/claims/0/verdict');
    expect(e!.message).toMatch(/unverifiable/i);
  });
});

// ---------------------------------------------------------------------------
// Tests — Review not approved (strict only)
// ---------------------------------------------------------------------------

describe('Review gate — review not approved (strict mode only)', () => {
  it('passes in default mode with pending review', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: pending`,
      }),
    );
    expectAccepted(bundle);
  });

  it('passes in default mode with rejected review', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: rejected`,
      }),
    );
    expectAccepted(bundle);
  });

  it('passes in default mode without a review at all', () => {
    const bundle = buildValidBundle(makeNarrative({}));
    expectAccepted(bundle);
  });

  it('rejects in strict mode when review.decision is pending', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: pending`,
      }),
    );
    const errors = expectRejected(bundle, { strict: true });
    const e = findByHintCode(errors, 'review-not-approved');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-cemetery.pl.md');
    expect(e!.jsonPointer).toBe('/review/decision');
    expect(e!.message).toMatch(/pending/);
  });

  it('rejects in strict mode when review.decision is rejected', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: rejected`,
      }),
    );
    const errors = expectRejected(bundle, { strict: true });
    const e = findByHintCode(errors, 'review-not-approved');
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/rejected/);
  });

  it('rejects in strict mode when no review object exists at all', () => {
    const bundle = buildValidBundle(makeNarrative({}));
    const errors = expectRejected(bundle, { strict: true });
    const e = findByHintCode(errors, 'review-not-approved');
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/missing/);
  });

  it('passes in strict mode with an approved review', () => {
    const bundle = buildValidBundle(
      makeNarrative({
        review: `  reviewedBy: jan\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: approved`,
      }),
    );
    expectAccepted(bundle, { strict: true });
  });
});

// ---------------------------------------------------------------------------
// Tests — Memorial tone (all modes)
// ---------------------------------------------------------------------------

describe('Review gate — tone memorial with empty body', () => {
  it('rejects a memorial segment with an empty body in default mode', () => {
    const bundle = buildValidBundle(makeNarrative({ tone: 'memorial', body: '' }));
    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'memorial-segment-empty');
    expect(e).toBeDefined();
    expect(e!.filePath).toBe('narratives/poi-cemetery.pl.md');
    expect(e!.jsonPointer).toBe('/tone');
    expect(e!.message).toMatch(/memorial/i);
    expect(e!.message).toMatch(/empty/i);
  });

  it('rejects a memorial segment with whitespace-only body', () => {
    const bundle = buildValidBundle(makeNarrative({ tone: 'memorial', body: '   \n  \n  ' }));
    const errors = expectRejected(bundle);
    const e = findByHintCode(errors, 'memorial-segment-empty');
    expect(e).toBeDefined();
  });

  it('accepts a memorial segment with a non-empty body', () => {
    const bundle = buildValidBundle(
      makeNarrative({ tone: 'memorial', body: '# Memorial\n\nContent.' }),
    );
    expectAccepted(bundle);
  });

  it('does not reject standard tone with empty body', () => {
    // standard tone has no content requirement
    const bundle = buildValidBundle(makeNarrative({ tone: 'standard', body: '' }));
    expectAccepted(bundle);
  });
});

// ---------------------------------------------------------------------------
// Property test — no bundle with a refuted claim ever validates
// ---------------------------------------------------------------------------

describe('Review gate — property: no bundle with a refuted claim ever validates', () => {
  it('rejects any bundle containing a refuted claim, regardless of other fields', () => {
    fc.assert(
      fc.property(
        fc.record({
          claimId: fc.string({ minLength: 1, maxLength: 20 }),
          claimText: fc.string({ minLength: 1, maxLength: 100 }),
          reviewedBy: fc.string({ minLength: 1, maxLength: 20 }),
          decision: fc.constantFrom('approved', 'rejected', 'pending') as fc.Arbitrary<
            'approved' | 'rejected' | 'pending'
          >,
          tone: fc.constantFrom('standard', 'memorial') as fc.Arbitrary<'standard' | 'memorial'>,
          hasOtherClaims: fc.boolean(),
          strict: fc.boolean(),
        }),
        (params) => {
          const claimsYaml = params.hasOtherClaims
            ? [
                `  - id: other-claim`,
                `    text: "Some other claim"`,
                `    verdict: confirmed`,
                `    sourceUrl: https://example.com/other`,
                `  - id: "${params.claimId.replace(/"/g, "'")}"`,
                `    text: "${params.claimText.replace(/"/g, "'").replace(/\n/g, ' ')}"`,
                `    verdict: refuted`,
              ].join('\n')
            : [
                `  - id: "${params.claimId.replace(/"/g, "'")}"`,
                `    text: "${params.claimText.replace(/"/g, "'").replace(/\n/g, ' ')}"`,
                `    verdict: refuted`,
              ].join('\n');

          const narrative = makeNarrative({
            claims: claimsYaml,
            review: `  reviewedBy: "${params.reviewedBy.replace(/"/g, "'").replace(/\n/g, ' ')}"\n  reviewedAt: "2026-07-01T10:00:00Z"\n  decision: ${params.decision}`,
            tone: params.tone,
            body: params.tone === 'memorial' ? '# Content\n\nNon-empty.' : '# Content',
          });

          const bundle = buildValidBundle(narrative);
          const result = validateBundle(
            virtualFileSystem(bundle),
            params.strict ? { strict: true } : undefined,
          );

          if (result.ok) {
            throw new Error(`Bundle with a refuted claim was accepted (strict=${params.strict})`);
          }

          const refutedErr = result.errors.find((e) => e.hint.code === 'refuted-claim');
          if (!refutedErr) {
            throw new Error(
              `Bundle was rejected but not with a refuted-claim error. Errors:\n` +
                result.errors
                  .map((e) => `  [${e.hint.code}] ${e.filePath} ${e.jsonPointer}: ${e.message}`)
                  .join('\n'),
            );
          }

          return true;
        },
      ),
      { numRuns: 100, seed: 180 },
    );
  });
});
