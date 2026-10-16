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
  // Tests run the TypeScript source: packages export it under the @konjir/source condition,
  // and their default export is the compiled dist/ that production runs.
  testEnvironmentOptions: { customExportConditions: ['@konjir/source', 'node', 'node-addons'] },
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/../../jest.setup.js'],
  globalSetup: '<rootDir>/../../jest.global-setup.js',
  globalTeardown: '<rootDir>/../../jest.global-teardown.js',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['@swc/jest', {
      // Legacy decorators with metadata, as NestJS and tsc's experimentalDecorators expect.
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      module: { type: 'es6' },
    }],
  },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Each test opens its own database, and the end-to-end tests start servers.
  testTimeout: 30_000,
};
