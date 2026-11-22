#!/usr/bin/env node
// Makes expo-modules-jsi compile with Xcode 26.2 (Swift 6.2), which SDK 58's expo-modules-jsi
// 58.0.23 doesn't: JavaScriptObject.swift's withEncodedValue fails with "sending 'slot' risks
// causing data races" (upstream: https://github.com/expo/expo/issues/52754, open). Swift 6.2
// doesn't carry `nonisolated(unsafe)` into the JavaScriptActor.assumeIsolated closure; Xcode 27's
// Swift 6.4 does. expo-modules-core 58.1 needs expo-modules-jsi ~58.0.23, so an older one can't be
// pinned instead.
//
// The fix passes the slot's address into the closure as a UInt, which is Sendable, and makes the
// same pointer from it there: the same code, which every Swift accepts. It runs at `npm install`
// and `npm ci` (this workspace's postinstall) and before `prebuild` and `ios`, edits only that one
// statement, and does nothing once upstream has changed it. Remove it when #52754 is fixed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
let dir;
try {
  dir = dirname(require.resolve('expo-modules-jsi/package.json', { paths: [dirname(require.resolve('expo-modules-core/package.json'))] }));
} catch {
  console.log('patch-expo-modules-jsi: expo-modules-jsi isn\'t installed; nothing to do');
  process.exit(0);
}
const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const file = join(dir, 'apple/Sources/ExpoModulesJSI/Runtime/Values/JavaScriptObject.swift');

const BROKEN = [
  '      try JavaScriptActor.assumeIsolated {',
  '        try encode(JavaScriptValue.Slot(slot), runtime)',
].join('\n');
const FIXED = [
  '      // konnect-mobile: expo/expo#52754, scripts/patch-expo-modules-jsi.mjs',
  '      let address = UInt(bitPattern: slot)',
  '      try JavaScriptActor.assumeIsolated {',
  '        try encode(JavaScriptValue.Slot(UnsafeMutablePointer<facebook.jsi.Value>(bitPattern: address)!), runtime)',
].join('\n');

const source = readFileSync(file, 'utf8');
if (source.includes(FIXED)) {
  console.log(`patch-expo-modules-jsi: expo-modules-jsi ${version} is already patched (expo/expo#52754)`);
} else if (source.split(BROKEN).length === 2) {
  writeFileSync(file, source.replace(BROKEN, FIXED));
  console.log(`patch-expo-modules-jsi: patched expo-modules-jsi ${version} for Xcode 26 (expo/expo#52754)`);
} else {
  console.log(`patch-expo-modules-jsi: expo-modules-jsi ${version} no longer has the statement expo/expo#52754 is about; nothing patched. If iOS builds pass, remove this script.`);
}
