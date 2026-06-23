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
  displayName: '@tramio/map',
  rootDir: __dirname,
  preset: shared.preset ?? 'ts-jest',
  testEnvironment: shared.testEnvironment ?? 'node',
  testMatch: [
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/src/**/*.test.tsx',
    '<rootDir>/tests/**/*.test.ts',
    '<rootDir>/tests/**/*.test.tsx',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
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
  // react-native ships ESM that Jest cannot parse without transformation.
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@maplibre/maplibre-react-native)/)',
  ],
  moduleNameMapper: {
    // Map react-native to our minimal mock
    '^react-native$': path.resolve(__dirname, 'src/__mocks__/react-native.ts'),
    // Map @maplibre/maplibre-react-native to our mock
    '^@maplibre/maplibre-react-native$': path.resolve(
      __dirname,
      'src/__mocks__/maplibre-react-native.ts',
    ),
  },
};
