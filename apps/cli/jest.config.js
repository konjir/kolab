import preset from '../../jest.preset.js';

// test/cwd.setup.js: each test file runs from an empty folder of its own, not from this checkout.
export default { ...preset, setupFilesAfterEnv: [...preset.setupFilesAfterEnv, '<rootDir>/test/cwd.setup.js'] };
