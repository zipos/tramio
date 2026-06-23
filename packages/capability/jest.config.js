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
  displayName: '@tramio/capability',
  rootDir: __dirname,
  preset: shared.preset ?? 'ts-jest',
  testEnvironment: shared.testEnvironment ?? 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts', '<rootDir>/src/**/*.test.tsx', '<rootDir>/tests/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.test.json',
        isolatedModules: true,
      },
    ],
  },
};
