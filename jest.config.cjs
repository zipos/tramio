/**
 * Tramio root Jest configuration — projects mode.
 *
 * Each package declares its own jest.config.js with a displayName.
 * The root config orchestrates them as `projects` so `npm test` discovers
 * every suite while each project gets only the mocks it actually needs.
 *
 * react-native / @maplibre mocks apply ONLY to packages that import them
 * (map, ui), NOT to pure-logic packages (engine, storage, clients, etc.).
 * This prevents silent masking of import-time crashes in the wiring layer.
 *
 * Device tests (`__device_tests__/`) are excluded from the default run.
 * To run them on demand:
 *   npx jest --selectProjects "@tramio/native" --testPathPattern __device_tests__ --testPathIgnorePatterns '/node_modules/'
 */

const path = require('path');

// Shared settings that all projects inherit (same file per-package configs spread).
const shared = require('./jest.shared.js');

/**
 * Helper: build a project entry from a per-package jest.config.js path.
 * We load it directly so each package owns its own testMatch, displayName,
 * moduleNameMapper, and transforms.
 */
function packageProject(pkgDir) {
  return path.resolve(__dirname, pkgDir);
}

/** @type {import('jest').Config} */
module.exports = {
  // --- FIX 1: Exclude device tests from `npm test` (they run ~50s against a fake bridge).
  // Run on demand: npx jest --selectProjects @tramio/native --testPathPattern __device_tests__ --testPathIgnorePatterns '/node_modules/'
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/ios/', '/android/', '/__device_tests__/'],

  // Property tests can take longer than the default 5s once numRuns is at 100.
  testTimeout: 30_000,

  // Coverage thresholds for critical pure-logic packages.
  // Measured 2026-07-31: engine has 90.23% stmts, 85.13% branches, 100% fns, 89.94% lines.
  // Thresholds set 2–3% below measured to avoid CI flaps from normal refactoring.
  coverageThreshold: {
    'packages/engine/src/': {
      statements: 88,
      branches: 82,
      functions: 95,
      lines: 87,
    },
  },

  projects: [
    // Pure-logic packages (NO react-native mock)
    packageProject('packages/engine'),
    packageProject('packages/storage'),
    packageProject('packages/clients'),
    packageProject('packages/backend'),
    packageProject('packages/capability'),
    packageProject('packages/authoring'),
    packageProject('packages/branding'),
    packageProject('packages/crypto-service'),
    packageProject('packages/simulator'),
    packageProject('packages/native'),

    // Packages that need react-native / maplibre mocks
    packageProject('packages/map'),
    packageProject('packages/ui'),

    // Tooling (repo-level test utilities)
    {
      ...shared,
      displayName: 'tooling',
      rootDir: path.resolve(__dirname, 'tooling'),
      testMatch: ['<rootDir>/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': [
          'ts-jest',
          {
            tsconfig: path.resolve(__dirname, 'tsconfig.test.json'),
            diagnostics: true,
            isolatedModules: true,
          },
        ],
      },
    },
  ],
};
