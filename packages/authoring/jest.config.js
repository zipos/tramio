/**
 * Jest config for @tramio/authoring.
 *
 * Shared helpers (fast-check setup, requirement-tagged property template) will be
 * provided by task 1.2 under a workspace path; this config is pre-wired to expect
 * them at `<rootDir>/../../jest.shared.js` and falls back to local defaults.
 */
const path = require('path');

let shared = {};
try {
  // Picked up once task 1.2 lands the shared Jest setup.
  shared = require(path.resolve(__dirname, '../../jest.shared.js'));
} catch (_e) {
  shared = {};
}

/** @type {import('jest').Config} */
module.exports = {
  ...shared,
  displayName: '@tramio/authoring',
  rootDir: __dirname,
  preset: shared.preset ?? 'ts-jest',
  testEnvironment: shared.testEnvironment ?? 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
