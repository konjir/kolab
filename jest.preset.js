/**
 * Shared Jest settings. Each project's jest.config.js spreads them.
 *
 * The packages are ES modules (they use import.meta), so Jest runs in ESM mode: the test
 * script sets --experimental-vm-modules, and @swc/jest strips the types without changing
 * the module format. Relative imports keep their .js extension, as NodeNext requires,
 * and the mapper points them at the .ts source.
 */
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/../../jest.setup.js'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['@swc/jest', {
      jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
      module: { type: 'es6' },
    }],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Each test opens its own PGlite database, and the end-to-end tests start servers.
  testTimeout: 30_000,
};
