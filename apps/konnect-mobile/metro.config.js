// Metro, as Expo configures it for a monorepo (it watches the workspace and resolves from the root
// node_modules), plus what the repo's libraries need:
// - the condition they export their TypeScript source under, `@konjir/source`, which
//   tsconfig.json (customConditions) and jest.config.js (customExportConditions) name too
// - their relative imports, written NodeNext's way with `.js` for a `.ts` file (`./limits.js`),
//   resolved to the `.ts` file, as tsc and jest.config.js's moduleNameMapper do
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.unstable_conditionNames = [...(config.resolver.unstable_conditionNames ?? []), '@konjir/source'];

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstream ?? context.resolveRequest;
  const fromRepoTs = /\.tsx?$/.test(context.originModulePath) && !context.originModulePath.includes(NODE_MODULES);
  if (fromRepoTs && moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName.slice(0, -'.js'.length), platform);
    } catch {
      // Not a .ts file after all: resolve the name as written.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
