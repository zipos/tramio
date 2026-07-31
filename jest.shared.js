/**
 * Shared Jest settings for all Tramio packages.
 *
 * Each per-package jest.config.js does:
 *   const shared = require(path.resolve(__dirname, '../../jest.shared.js'));
 *   module.exports = { ...shared, displayName: '...', rootDir: __dirname, ... };
 *
 * The root jest.config.cjs references these same per-package configs as
 * `projects` entries, so `npm test` discovers everything via the project-level
 * configs while this file provides the shared defaults they spread in.
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/../../tsconfig.test.json',
        diagnostics: true,
        isolatedModules: true,
      },
    ],
  },
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  // NOTE: testTimeout is set at the root jest.config.cjs level (global config),
  // not here, because Jest treats it as a global-only option in projects mode.
};
