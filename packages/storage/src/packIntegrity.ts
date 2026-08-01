// PackIntegrityError — typed integrity failures for installed Offline_Packs.
//
// Every load-time integrity check (signature, hash, identity) throws this
// specific error so callers can distinguish "pack is corrupt / tampered"
// from transient IO failures.

/**
 * Discriminated kinds for pack integrity failures.
 *
 * - `missing-lock`: No `.tramio/MANIFEST.lock.signed.json` found — pack
 *   predates the signed-lock persistence (legacy) or was manually installed.
 * - `signature`: Ed25519 signature on the lock envelope did not verify.
 *   This also covers kid-policy rejections: the verifier is the sole owner
 *   of kid validation; a kid mismatch results in `verify() → false` which
 *   maps to `signature`.
 * - `identity-mismatch`: Lock `bundleId` or `version` does not match the
 *   requested PackRef.
 * - `hash-mismatch`: On-disk asset SHA-256 does not match the lock entry.
 * - `size-mismatch`: On-disk asset byte size does not match the lock entry.
 * - `asset-missing`: A listed asset file is absent from the pack directory.
 * - `asset-not-listed`: An asset was expected (e.g. narrative referenced by
 *   pois.json) but is not present in the lock's asset list — ambiguous
 *   provenance.
 * - `invalid-content`: The signed lock authenticates the bytes, but their
 *   content is structurally invalid (malformed JSON, unterminated narrative
 *   frontmatter, etc.). This is a publisher error, not a tampering signal.
 */
export type PackIntegrityKind =
  | 'missing-lock'
  | 'signature'
  | 'identity-mismatch'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'asset-missing'
  | 'asset-not-listed'
  | 'invalid-content';

/**
 * Thrown when an installed Offline_Pack fails load-time integrity verification.
 *
 * Contains a machine-readable `kind`, the `relativePath` of the offending
 * asset (or the control file), and a safe `userMessage` suitable for display
 * without leaking internal paths.
 */
export class PackIntegrityError extends Error {
  public override readonly name = 'PackIntegrityError';
  public readonly kind: PackIntegrityKind;
  public readonly relativePath: string;
  public readonly userMessage: string;

  constructor(kind: PackIntegrityKind, relativePath: string, detail?: string) {
    const userMessage = userMessageForKind(kind, relativePath);
    const internalDetail = detail ? `: ${detail}` : '';
    super(`Pack integrity failure [${kind}] at ${relativePath}${internalDetail}`);
    this.kind = kind;
    this.relativePath = relativePath;
    this.userMessage = userMessage;
  }
}

function userMessageForKind(kind: PackIntegrityKind, relativePath: string): string {
  switch (kind) {
    case 'missing-lock':
      return 'This tour pack needs to be re-downloaded to verify its integrity.';
    case 'signature':
      return 'The tour pack signature could not be verified. Please re-download the pack.';
    case 'identity-mismatch':
      return 'The tour pack identity does not match. Please re-download.';
    case 'hash-mismatch':
      return `A pack file has been modified (${relativePath}). Please re-download the tour.`;
    case 'size-mismatch':
      return `A pack file has an unexpected size (${relativePath}). Please re-download.`;
    case 'asset-missing':
      return `A required pack file is missing (${relativePath}). Please re-download the tour.`;
    case 'asset-not-listed':
      return `A pack file cannot be verified (${relativePath}). Please re-download the tour.`;
    case 'invalid-content':
      return `A pack file has invalid content (${relativePath}). Please re-download the tour.`;
  }
}
