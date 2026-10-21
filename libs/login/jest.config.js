import preset from '../../jest.preset.js';

// The login library needs no database, so none of the shared setup that opens and closes one.
export default { ...preset, setupFilesAfterEnv: [], globalSetup: undefined, globalTeardown: undefined };
