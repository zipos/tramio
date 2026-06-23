// Filesystem layout helpers for the on-device pack store.
//
// design.md "## Offline Pack Format and Download Strategy" pins the on-disk
// layout to `${docs}/packs/{bundleId}/{version}/`. The downloader stages an
// in-progress version under a sibling `${version}.staging/` directory and
// renames atomically only after every asset's SHA-256 matches the lock file
// (Req 3.1, 3.5, 23.1).
//
// These helpers are intentionally *string-only*. They never touch the
// filesystem, so they are trivially testable and reusable from both the
// production wiring and unit tests.
//
// @see design.md "## Offline Pack Format and Download Strategy"
// @see design.md "Storage_Manager"
// @see Requirements 3.1, 3.5

import * as path from 'node:path';

/**
 * Identifier of an Offline_Pack on disk. `bundleId` and `version` are
 * authored strings; we accept them as opaque identifiers and only validate
 * that they are non-empty and contain no path separators (defense against
 * caller-supplied path traversal).
 */
export interface PackRef {
  bundleId: string;
  version: string;
}

/**
 * Thrown when a `bundleId` or `version` is empty, contains a path separator,
 * or contains a `..` segment that could escape the pack store.
 *
 * @inferred design.md does not enumerate the validation rules but the
 *           atomicity guarantees only hold if the caller cannot inject
 *           arbitrary path segments. We refuse on the way in.
 */
export class InvalidPackRefError extends Error {
  public override readonly name = 'InvalidPackRefError';
}

const BAD_SEGMENT = /[/\\]/u;

function assertSafeSegment(label: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidPackRefError(`${label} must be a non-empty string`);
  }
  if (BAD_SEGMENT.test(value)) {
    throw new InvalidPackRefError(`${label} must not contain path separators: ${value}`);
  }
  if (value === '.' || value === '..' || value.includes('\u0000')) {
    throw new InvalidPackRefError(`${label} contains a forbidden segment: ${value}`);
  }
}

/**
 * Configuration for the filesystem layout. `docsDir` is the platform's
 * documents directory in production (RN: `FileSystem.documentDirectory`,
 * Node: any directory). The packs subtree is rooted under `${docsDir}/packs/`.
 */
export interface PathLayout {
  /** Absolute path to the platform documents directory. */
  docsDir: string;
}

/** Root of the pack store: `${docsDir}/packs/`. */
export function packsRoot(layout: PathLayout): string {
  return path.join(layout.docsDir, 'packs');
}

/**
 * Final pack directory: `${docsDir}/packs/{bundleId}/{version}/`.
 *
 * @throws InvalidPackRefError when bundleId or version is unsafe.
 */
export function packDir(layout: PathLayout, ref: PackRef): string {
  assertSafeSegment('bundleId', ref.bundleId);
  assertSafeSegment('version', ref.version);
  return path.join(packsRoot(layout), ref.bundleId, ref.version);
}

/**
 * Staging directory used while a pack is being downloaded:
 * `${docsDir}/packs/{bundleId}/{version}.staging/`.
 *
 * The `.staging` suffix is part of the design contract: the downloader
 * renames `{version}.staging` -> `{version}` only after every asset is
 * verified, which is the moment a pack becomes startable (Req 3.1, 3.5).
 *
 * @throws InvalidPackRefError when bundleId or version is unsafe.
 */
export function stagingDir(layout: PathLayout, ref: PackRef): string {
  assertSafeSegment('bundleId', ref.bundleId);
  assertSafeSegment('version', ref.version);
  return path.join(packsRoot(layout), ref.bundleId, `${ref.version}.staging`);
}
