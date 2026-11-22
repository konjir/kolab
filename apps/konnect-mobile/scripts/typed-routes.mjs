#!/usr/bin/env node
// Writes expo-router's typed routes (.expo/types/router.d.ts) and expo-env.d.ts, as `expo start`
// does, so `typecheck` checks every href against the routes in app/ without a dev server running
// (in CI, say). It calls the generator `expo start` and `expo customize` call
// (@expo/router-server's typed-routes), with the router's root set as Expo CLI sets it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const typesDirectory = join(root, '.expo', 'types');

process.env.EXPO_ROUTER_APP_ROOT = join(root, 'app');
mkdirSync(typesDirectory, { recursive: true });
writeFileSync(join(root, 'expo-env.d.ts'), '/// <reference types="expo/types" />\n\n// NOTE: This file should not be edited and should be in your git ignore');
const typedRoutes = require(require.resolve('@expo/router-server/build/typed-routes', { paths: [dirname(require.resolve('expo/package.json'))] }));
typedRoutes.regenerateDeclarations(typesDirectory, {});
