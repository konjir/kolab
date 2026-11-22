// `expo lint`: Expo's rules (eslint-config-expo), for this app only; the rest of the repo has no ESLint.
//
// typescript-eslint needs TypeScript's JS API, which the repo's TypeScript 7 doesn't have, so npm
// installs it beside a TypeScript 6 of its own inside eslint-config-expo's folder rather than at the
// workspace root (and the root package.json's overrides give ts-api-utils the same). eslint-plugin-import,
// at the root, then can't find the parser and the resolver by name, so they are named here by path,
// from eslint-config-expo's folder. The resolver also reads the repo's libraries' TypeScript source
// (the `@konjir/source` condition, as Metro, Jest and tsconfig.json do) and tsconfig.json's `@/` paths.
const path = require('node:path');
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

const expoDir = path.dirname(require.resolve('eslint-config-expo/package.json'));
const fromExpo = (name) => require.resolve(name, { paths: [expoDir] });
const PARSER = fromExpo('@typescript-eslint/parser');
const RESOLVER = fromExpo('eslint-import-resolver-typescript');
const RESOLVER_OPTIONS = {
  project: path.join(__dirname, 'tsconfig.json'),
  conditionNames: ['@konjir/source', 'types', 'react-native', 'import', 'require', 'default'],
};

const rename = (o, from, to, value) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => (k === from ? [to, value ?? v] : [k, v])));

const byPath = (config) => {
  const s = config.settings;
  if (!s || !(s['import/parsers'] || s['import/resolver'])) return config;
  return {
    ...config,
    settings: {
      ...s,
      ...(s['import/parsers'] ? { 'import/parsers': rename(s['import/parsers'], '@typescript-eslint/parser', PARSER) } : {}),
      ...(s['import/resolver'] ? { 'import/resolver': rename(s['import/resolver'], 'typescript', RESOLVER, RESOLVER_OPTIONS) } : {}),
    },
  };
};

module.exports = defineConfig([
  ...[expoConfig].flat().map(byPath),
  { settings: { 'import/resolver': { [RESOLVER]: RESOLVER_OPTIONS } } },
  { ignores: ['dist/*', 'ios/*', 'android/*', '.expo/*', 'expo-env.d.ts'] },
]);
