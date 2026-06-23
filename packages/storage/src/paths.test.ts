// Pure unit tests for the path helpers — no filesystem access.

import * as path from 'node:path';

import { packDir, packsRoot, stagingDir, InvalidPackRefError } from './paths';

describe('paths', () => {
  const layout = { docsDir: '/var/app/docs' };

  it('packsRoot lives under docsDir/packs', () => {
    expect(packsRoot(layout)).toBe(path.join('/var/app/docs', 'packs'));
  });

  it('packDir composes ${docs}/packs/{bundleId}/{version}/', () => {
    expect(packDir(layout, { bundleId: 'wroclaw-tram-7', version: '1.4.2' })).toBe(
      path.join('/var/app/docs', 'packs', 'wroclaw-tram-7', '1.4.2'),
    );
  });

  it('stagingDir appends `.staging` to the version segment', () => {
    expect(stagingDir(layout, { bundleId: 'wroclaw-tram-7', version: '1.4.2' })).toBe(
      path.join('/var/app/docs', 'packs', 'wroclaw-tram-7', '1.4.2.staging'),
    );
  });

  it('rejects path-traversal attempts in bundleId', () => {
    expect(() => packDir(layout, { bundleId: '../etc', version: '1' })).toThrow(
      InvalidPackRefError,
    );
    expect(() => packDir(layout, { bundleId: 'a/b', version: '1' })).toThrow(
      InvalidPackRefError,
    );
    expect(() => packDir(layout, { bundleId: '..', version: '1' })).toThrow(
      InvalidPackRefError,
    );
  });

  it('rejects path-traversal attempts in version', () => {
    expect(() => stagingDir(layout, { bundleId: 'b', version: '../1' })).toThrow(
      InvalidPackRefError,
    );
    expect(() => stagingDir(layout, { bundleId: 'b', version: '' })).toThrow(
      InvalidPackRefError,
    );
  });
});
