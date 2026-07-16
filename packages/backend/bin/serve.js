#!/usr/bin/env node
/* eslint-disable */
// JS shim for `npm run backend:dev`. Registers ts-node in CommonJS mode so
// `serve.ts` can use extensionless relative imports under Node 22.

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

require(path.resolve(__dirname, '..', 'src', 'bin', 'serve.ts'));
