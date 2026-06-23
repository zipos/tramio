const path = require('path');

let shared = {};
try {
  shared = require(path.resolve(__dirname, '../../jest.shared.js'));
} catch (_e) {
  shared = {};
}

/** @type {import('jest').Config} */
module.exports = {
  ...shared,
  displayName: '@tramio/native',
  rootDir: __dirname,
  preset: shared.preset ?? 'ts-jest',
  testEnvironment: shared.testEnvironment ?? 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/tests/**/*.test.ts'],
  // Device tests are excluded from CI runs by default. Run them with:
  //   npx jest --testPathPattern __device_tests__
  testPathIgnorePatterns: ['/node_modules/', '/__device_tests__/'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
