// `bundle-validate` CLI for the authoring harness (task 2.3).
//
// Usage:
//   bundle-validate [--json] [--strict] <bundle-dir>
//
// Exits 0 when the bundle validates cleanly, 1 when one or more
// `BundleValidationError`s are produced, and 2 when the arguments
// themselves are malformed (missing directory, unknown flag).
//
// The default "human-readable" output groups errors by their bundle-
// relative `filePath` and prints, per error, two lines:
//
//     <filePath> <jsonPointer> :: <message>
//       hint: <hint.text>
//
// `--json` instead prints the `BundleValidationError[]` array verbatim
// (pretty-printed) on stdout, which lets editor harnesses and CI
// pipelines parse the output without screen-scraping.
//
// `--strict` is reserved for a future "treat warnings as errors" mode;
// validation today produces only errors, so the flag is accepted and
// no-ops, with a note in `--help`. Wiring it up now keeps the surface
// stable so callers do not have to relearn the CLI when warnings land.
//
// The module is structured so the test harness (and any future host
// process) can drive it without subprocesses: `runCli` accepts a
// pre-built `BundleFileSystem` plus a `CliIo` adapter and returns the
// exit code. The `if (require.main === module)` block at the bottom is
// the only place that touches `process.argv` / `process.stdout` /
// `process.exitCode` directly.

import {
  nodeFileSystem,
  validateBundle,
  type BundleFileSystem,
  type BundleValidationError,
} from '../validator';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Output stream adapter; tests inject string-collecting impls. */
export interface CliIo {
  /** Write a single line (newline appended by the caller). */
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface CliOptions {
  readonly json: boolean;
  /**
   * Reserved for "treat warnings as errors". The validator emits only
   * errors today, so the flag is accepted and currently has no effect.
   */
  readonly strict: boolean;
}

export type ParsedArgs =
  | { readonly ok: true; readonly directory: string; readonly options: CliOptions }
  | { readonly ok: false; readonly error: string };

const USAGE = 'Usage: bundle-validate [--json] [--strict] <bundle-dir>';

/**
 * Parse the argv slice that follows the executable + script (i.e. what
 * `process.argv.slice(2)` would yield). Pure; no I/O.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let json = false;
  let strict = false;
  let directory: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--help' || arg === '-h') {
      return { ok: false, error: '__help__' };
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `unknown flag "${arg}"` };
    } else if (directory === undefined) {
      directory = arg;
    } else {
      return {
        ok: false,
        error: `unexpected positional argument "${arg}" (already received "${directory}")`,
      };
    }
  }

  if (directory === undefined) {
    return { ok: false, error: 'missing required <bundle-dir> positional argument' };
  }

  return { ok: true, directory, options: { json, strict } };
}

/**
 * Run the validator against an arbitrary `BundleFileSystem`. Returns
 * the exit code (0 on success, 1 on validation failures). Pure aside
 * from `io.stdout` / `io.stderr` calls.
 */
export function runCli(fsAdapter: BundleFileSystem, options: CliOptions, io: CliIo): number {
  const result = validateBundle(fsAdapter);

  if (result.ok) {
    if (options.json) {
      // Empty error array is the JSON contract for "no problems".
      io.stdout('[]');
    } else {
      io.stdout('Bundle is valid.');
    }
    return 0;
  }

  if (options.json) {
    io.stdout(JSON.stringify(result.errors, null, 2));
    return 1;
  }

  printHumanReadable(result.errors, io);
  return 1;
}

/**
 * Run the CLI from a raw argv slice. Resolves the bundle directory via
 * `nodeFileSystem`. Returns the exit code; the caller is responsible
 * for surfacing it (typically through `process.exitCode`).
 */
export function runCliFromArgv(argv: readonly string[], io: CliIo): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.error === '__help__') {
      io.stdout(USAGE);
      io.stdout('');
      io.stdout('Validates a Tramio Content_Bundle directory against the');
      io.stdout('Authoring_Schema and cross-file invariants.');
      io.stdout('');
      io.stdout('Flags:');
      io.stdout('  --json     Print BundleValidationError[] as JSON on stdout.');
      io.stdout('  --strict   Treat warnings as errors (reserved; no-op today).');
      io.stdout('  -h, --help Show this message.');
      return 0;
    }
    io.stderr(`bundle-validate: ${parsed.error}`);
    io.stderr(USAGE);
    return 2;
  }

  const fsAdapter = nodeFileSystem(parsed.directory);
  return runCli(fsAdapter, parsed.options, io);
}

// ---------------------------------------------------------------------------
// Human-readable formatter
// ---------------------------------------------------------------------------

function printHumanReadable(errors: readonly BundleValidationError[], io: CliIo): void {
  // Group by filePath so authors see all problems with a single file
  // adjacent to each other. Insertion order of the Map preserves the
  // original error order, which itself is deterministic from the
  // validator (top-to-bottom over manifest → route → pois → narratives
  // → standby).
  const grouped = new Map<string, BundleValidationError[]>();
  for (const e of errors) {
    const list = grouped.get(e.filePath);
    if (list === undefined) grouped.set(e.filePath, [e]);
    else list.push(e);
  }

  io.stderr(
    `bundle-validate: ${errors.length} error${errors.length === 1 ? '' : 's'} in ${grouped.size} file${grouped.size === 1 ? '' : 's'}`,
  );

  for (const [filePath, errs] of grouped) {
    io.stderr('');
    io.stderr(`${filePath}:`);
    for (const err of errs) {
      // The pointer is RFC-6901; an empty pointer means "the file
      // itself" (e.g. parse error). Render that as `<root>` so the
      // output stays a fixed-shape three-token line.
      const pointer = err.jsonPointer === '' ? '<root>' : err.jsonPointer;
      io.stderr(`  ${err.filePath} ${pointer} :: ${err.message}`);
      io.stderr(`    hint: ${err.hint.text}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/* istanbul ignore next -- exercised only when the file is run as a script. */
if (require.main === module) {
  const exitCode = runCliFromArgv(process.argv.slice(2), {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
  process.exitCode = exitCode;
}
