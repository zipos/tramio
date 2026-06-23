#!/usr/bin/env node
/* eslint-disable */
// JS shim for the `bundle-validate` CLI exposed via the `bin` field of
// @tramio/authoring. The implementation lives in TypeScript at
// `src/bin/bundle-validate.ts`; until task 1.2's tooling produces a
// compiled `dist/` we register `ts-node/register` here so consumers
// can invoke the CLI directly via `npm exec bundle-validate -- <dir>`
// or `npx bundle-validate <dir>` from the workspace root.
//
// We register ts-node in transpile-only mode with `skipProject: true`
// so it ignores the workspace's Expo-flavored tsconfig (which inherits
// `customConditions` and other settings incompatible with a Node CLI)
// and supplies an explicit CommonJS compilerOptions object instead.
// When task 1.2 adds a compiled `dist/` build, this shim should be
// replaced with a direct `require('../dist/bin/bundle-validate.js')`.

const path = require('path');

require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    target: 'ES2022',
    esModuleInterop: true,
    skipLibCheck: true,
    isolatedModules: true,
    resolveJsonModule: true,
  },
});

const { runCliFromArgv } = require(
  path.resolve(__dirname, '..', 'src', 'bin', 'bundle-validate.ts'),
);

const exitCode = runCliFromArgv(process.argv.slice(2), {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
});
process.exitCode = exitCode;
