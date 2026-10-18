import preset from '../../jest.preset.js';

/** Component tests: React in jsdom. The page imports no Node module, so neither do they. */
export default {
  ...preset,
  testEnvironment: 'jsdom',
  testEnvironmentOptions: { customExportConditions: ['@konjir/source', 'browser'] },
  testMatch: ['<rootDir>/test/**/*.test.tsx'],
  // No database here: the workspace's Postgres setup and teardown aren't needed.
  setupFilesAfterEnv: [],
  globalSetup: undefined,
  globalTeardown: undefined,
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } }, target: 'es2022' },
      module: { type: 'es6' },
    }],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1', '\\.css$': '<rootDir>/test/style-stub.js' },
};
