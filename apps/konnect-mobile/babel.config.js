// Expo's preset, stated so Jest (jest-expo) finds the same one Metro uses in this monorepo.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
