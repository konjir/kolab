// jest-expo's iOS preset, plus the condition the repo's libraries export their TypeScript source
// under (as metro.config.js and tsconfig.json have it), and their NodeNext-style `.js` imports
// pointed at the `.ts` files.
const preset = require('jest-expo/jest-preset');

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/test/**/*.test.ts?(x)'],
  testEnvironmentOptions: {
    ...preset.testEnvironmentOptions,
    customExportConditions: [...(preset.testEnvironmentOptions?.customExportConditions ?? ['require', 'react-native']), '@konjir/source'],
  },
  moduleNameMapper: {
    ...preset.moduleNameMapper,
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
