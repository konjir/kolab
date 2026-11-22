// The runtime version a built binary carries, read from the binary itself.
//
// With runtimeVersion's fingerprint policy, Expo.plist (iOS) and the manifest's
// EXPO_RUNTIME_VERSION (Android) hold only the sentinel `file:fingerprint`. The hash is in a file
// named `fingerprint` that expo-updates writes at build time (utils/build/createUpdatesResources.js)
// and reads at launch:
//   - iOS: EXUpdates.bundle/fingerprint, inside the app bundle (UpdatesConfig.swift,
//     getRuntimeVersion: Bundle(for: UpdatesConfig.self)/EXUpdates.bundle, resource "fingerprint").
//     In an .ipa that is Payload/<App>.app/EXUpdates.bundle/fingerprint, or under the framework's
//     folder when expo-updates is linked dynamically.
//   - Android: the asset `fingerprint` (UpdatesConfiguration.kt, context.assets.open("fingerprint"),
//     written by ExpoUpdatesPlugin.kt's createUpdatesResources task). In an .aab that is
//     base/assets/fingerprint, and assets/fingerprint in an .apk.
//
// Its contents are the hash alone (createFingerprintForBuildAsync.js writes fingerprint.hash).
import { spawnSync } from 'node:child_process';

export const FINGERPRINT_ENTRY = {
  ios: /(^|\/)EXUpdates\.bundle\/fingerprint$/,
  android: /(^|\/)assets\/fingerprint$/,
};

/**
 * Every fingerprint file in `artifact` (a zip: .ipa, .aab or .apk) for `platform`, with its trimmed
 * contents. Throws if the artifact can't be read.
 * @param {string} artifact
 * @param {'ios' | 'android'} platform
 * @returns {{ entry: string, value: string }[]}
 */
export function embeddedFingerprints(artifact, platform) {
  const pattern = FINGERPRINT_ENTRY[platform];
  if (!pattern) throw new Error(`unknown platform ${platform}`);
  const listed = spawnSync('unzip', ['-Z1', artifact], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error(`can't read ${artifact}`);
  return listed.stdout.split('\n').filter((e) => pattern.test(e)).map((entry) => {
    // unzip takes entry names as wildcards, so escape them to name this one entry alone.
    const read = spawnSync('unzip', ['-p', artifact, entry.replace(/[[\]*?\\]/g, '\\$&')], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (read.status !== 0) throw new Error(`can't read ${entry} in ${artifact}`);
    return { entry, value: read.stdout.trim() };
  });
}

/**
 * Whether `artifact` embeds exactly the runtime version `want`: at least one fingerprint file, and
 * each one's trimmed contents equal to `want`.
 * @returns {{ ok: boolean, found: { entry: string, value: string }[] }}
 */
export function embedsFingerprint(artifact, platform, want) {
  const found = embeddedFingerprints(artifact, platform);
  return { ok: found.length > 0 && found.every((f) => f.value === want), found };
}
