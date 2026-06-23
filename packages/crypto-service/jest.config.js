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
  displayName: '@tramio/crypto-service',
  rootDir: __dirname,
  preset: shared.preset ?? 'ts-jest',
  testEnvironment: shared.testEnvironment ?? 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
};
