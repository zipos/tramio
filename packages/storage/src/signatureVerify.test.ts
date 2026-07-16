jest.mock('@noble/ed25519', () => ({
  verifyAsync: jest.fn(async () => true),
}));

import * as ed from '@noble/ed25519';

import { verifyManifestSignatureSpki } from './signatureVerify';
import type { SignedManifest } from './downloader-types';

const verifyAsync = ed.verifyAsync as jest.MockedFunction<typeof ed.verifyAsync>;

describe('verifyManifestSignatureSpki', () => {
  const payload: SignedManifest['payload'] = {
    bundleId: 'demo',
    version: '1.0.0',
    assets: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  // Minimal SPKI-shaped blob (last 32 bytes = raw key for extractEd25519PublicKey).
  const publicKeySpkiB64Url = Buffer.from(new Uint8Array(44).fill(7)).toString('base64url');
  const signature = Buffer.from(new Uint8Array(64).fill(1)).toString('base64url');

  beforeEach(() => {
    verifyAsync.mockReset();
    verifyAsync.mockResolvedValue(true);
  });

  it('accepts a valid signature with matching kid', async () => {
    const signed: SignedManifest = { payload, signature, kid: 'cat-001' };
    await expect(verifyManifestSignatureSpki(publicKeySpkiB64Url, signed, 'cat-001')).resolves.toBe(
      true,
    );
    expect(verifyAsync).toHaveBeenCalled();
  });

  it('rejects wrong kid without calling ed25519 verify', async () => {
    const signed: SignedManifest = { payload, signature, kid: 'cat-other' };
    await expect(verifyManifestSignatureSpki(publicKeySpkiB64Url, signed, 'cat-001')).resolves.toBe(
      false,
    );
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('returns false when noble verify fails', async () => {
    verifyAsync.mockResolvedValue(false);
    const signed: SignedManifest = { payload, signature, kid: 'cat-001' };
    await expect(verifyManifestSignatureSpki(publicKeySpkiB64Url, signed, 'cat-001')).resolves.toBe(
      false,
    );
  });
});
