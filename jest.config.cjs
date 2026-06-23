/**
 * Tramio Jest configuration.
 *
 * The repo will grow into a workspace under `packages/*` (task 1.3). Until
 * then this root config runs ts-jest against any `*.test.ts` / `*.test.tsx`
 * found anywhere in the tree. When per-package configs land they should
 * extend this one via `preset: 'ts-jest'` and add their own `displayName`.
 *
 * fast-check property tests run through this same Jest runner; the shared
 * `numRuns >= 100` and CI-seed wiring lives in `tooling/property.ts` so it
 * is enforced at every call site rather than via a global plugin.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tooling', '<rootDir>/packages'],
  testMatch: [
    '<rootDir>/tooling/**/*.test.ts',
    '<rootDir>/packages/**/*.test.ts',
    '<rootDir>/packages/**/*.test.tsx',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
        diagnostics: true,
        isolatedModules: true,
      },
    ],
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/ios/', '/android/'],
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  // Property tests can take longer than the default 5s once numRuns is at 100.
  testTimeout: 30_000,
};
