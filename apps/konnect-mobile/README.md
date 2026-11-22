# konnect for iOS and Android

`@konjir/konnect-mobile`: konnect on a phone, for talking with the people and agents on your teams. It is an Expo SDK 58 app (React Native 0.88, React 19.3.0, Hermes, the New Architecture) in the root npm workspaces. The plan is [`docs/plans/konnect-mobile.md`](../../docs/plans/konnect-mobile.md). This is its phase 1 scaffold: four placeholder tabs in the brand's themes, and phase 0's spikes.

Every operation is an Nx target, run from the repository root as `npx nx run @konjir/konnect-mobile:<target>`. Arguments after `--` go on to the command, such as `-- --platform ios` or `-- --message "Fix the composer"`.

## Develop

| Target | What it does |
| --- | --- |
| `prebuild` | `expo prebuild --clean`: writes `ios/` and `android/` from `app.config.ts`. Both are generated and gitignored (CNG). |
| `ios`, `android` | `expo run:ios`, `expo run:android`: a local dev build, installed on a simulator or emulator, with Metro. |
| `start` | `expo start --dev-client`: Metro, for a dev build that is already installed. |
| `local-kolab` | A throwaway Kolab from this checkout on `http://127.0.0.1:7432/mcp`, with Ann and Bo signed in to team `hub`, for a dev build's spikes (below). |

`APP_VARIANT` (`development` by default, `preview`, `production`) picks the app: its name, bundle ID and package (`com.konjir.konnect.dev`, `.preview`, or none), and URL scheme, which is the same name. The three install side by side. `KONNECT_URL` points a build at another Kolab; it defaults to `https://kolab.konjir.com/mcp`.

The app imports `@konjir/brand` and `@konjir/types` as TypeScript source, through the `@konjir/source` export condition: `metro.config.js`, `jest.config.js` and `tsconfig.json` each name it. Metro also resolves the libraries' NodeNext-style `./x.js` imports to `./x.ts`. The brand's fonts (Fraunces, Instrument Sans and JetBrains Mono, from `@expo-google-fonts`) are embedded at build time by the `expo-font` config plugin.

### On this machine (macOS, Xcode 26.2)

```sh
npx nx run @konjir/konnect-mobile:ios          # or: prebuild, then xcodebuild with -derivedDataPath
```

`expo-modules-jsi` 58.0.23, which SDK 58's `expo-modules-core` 58.1 needs, doesn't compile with Xcode 26.2 (Swift 6.2): `JavaScriptObject.swift` fails with "sending 'slot' risks causing data races" ([expo/expo#52754](https://github.com/expo/expo/issues/52754), open). Expo builds it with Xcode 27 (Swift 6.4). `scripts/patch-expo-modules-jsi.mjs` rewrites that one statement into the equivalent code every Swift accepts. It runs as this workspace's `postinstall` (on `npm install` and `npm ci`) and again before `prebuild` and `ios`. It does nothing once upstream has changed the code. Remove it when the issue is fixed. CI installs with `--ignore-scripts`, but builds no native code.

Android isn't built or run on this machine yet: there is no Android SDK.

### The spikes (development variant only)

With `local-kolab` and `start` running and a dev build on the simulator:

```sh
xcrun simctl openurl booted "com.konjir.konnect.dev://dev/mcp"     # the MCP client: tools/call and subscriptions/listen
xcrun simctl openurl booted "com.konjir.konnect.dev://dev/oauth"   # expo-auth-session, up to the native redirect Kolab refuses
xcrun simctl openurl booted "com.konjir.konnect.dev://dev/brand"   # every icon and face, in the current theme
```

iOS asks whether to open each link in the app. With nobody to tap Open, start Metro with `EXPO_PUBLIC_DEV_ROUTE=/dev/mcp` instead (`src/dev/DevStart.tsx`, dev bundles only), and launch the app with `xcrun simctl launch booted com.konjir.konnect.dev --initialUrl http://127.0.0.1:8081`. Each spike logs to the screen and to Metro. `local-kolab` hands the build its URL and two throwaway tokens at `http://127.0.0.1:7433/spike`, on loopback only. Never point the spikes at production.

## Check

| Target | What it does |
| --- | --- |
| `typecheck` | Writes the typed routes (`scripts/typed-routes.mjs`), then `tsc` on the app and on `app.config.ts`. Cached. |
| `lint` | `expo lint` (eslint-config-expo), with no warnings allowed. Cached. |
| `test` | Jest with `jest-expo`. Cached. |
| `doctor` | `expo-doctor`. It accepts one failure on purpose: eas-cli is a pinned devDependency, which expo-doctor flags (`scripts/doctor.mjs`). |
| `deps-check` | `expo install --check`: every library at the version SDK 58 pins. |
| `fingerprint` | Each platform's native fingerprint, the runtime version an update must match (`scripts/fingerprint.mjs`). |
| `bundle-scan` | `expo export` for iOS and Android into `dist/bundle`, then a scan for anything that looks like a token or a secret (`scripts/bundle-scan.mjs`). |
| `e2e` | The Maestro flows in `.maestro/` against an installed build. Maestro is installed apart from npm. |

The app type-checks and lints with its own TypeScript 6.0 (SDK 58's), not the repo's 7.0: typescript-eslint needs TypeScript's JS API, which 7.0 doesn't have, and `expo install --check` expects 6.0. So npm installs typescript-eslint beside a TypeScript 6 of its own, and `eslint.config.js` names its parser and resolver by path. The root `package.json` overrides `ts-api-utils`'s TypeScript for the same reason.

`.github/workflows/mobile.yml` runs `typecheck`, `lint`, `test`, `doctor`, `deps-check` and `bundle-scan` on every pull request that touches the app, its libraries or the dependencies. `ci.yml` also runs `typecheck`, `lint` and `test`, as it does for every affected project.

## Build and release (EAS)

| Target | What it runs |
| --- | --- |
| `build-dev` | `eas build --profile development`. The `development-simulator` profile builds for the iOS simulator. |
| `build-preview` | `eas build --profile preview` (internal distribution) |
| `build-production` | `eas build --profile production --auto-submit` |
| `submit` | `eas submit --profile production --latest` |
| `update-preview`, `update-production` | `eas update --channel <channel>`, with `-- --message "…"` |
| `version` | `eas build:version:get` |
| `credentials` | `eas credentials` (interactive) |
| `eas-whoami` | `eas whoami` |
| `env-pull` | `eas env:pull`, with `-- --environment <env>` |

eas-cli is pinned as a devDependency (`eas.json` requires the same version) and run through `npx`, never installed globally. Each profile sets `APP_VARIANT` and has its own update channel. Builds run on the Node version production runs, which `mobile.yml` checks. Updates reach only builds with the same native fingerprint (`runtimeVersion: { policy: 'fingerprint' }`).

### Linking EAS

The app isn't linked to an EAS project yet, so every EAS target but `eas-whoami` says "not linked" and stops before eas-cli can offer to create a project under whichever Expo account is signed in. Linking is Lee's, once the Expo organization `konjir` exists:

1. Make the Expo organization `konjir`, and the Apple Developer team and Google Play account.
2. In this folder, run `npx eas init` as a member of `konjir`, creating the project `konnect`.
3. Set `EAS_PROJECT_ID` and `EAS_OWNER` (`konjir`) in `app.config.ts` from what it prints, rather than letting it write an `app.json`. That also gives the builds their update URL.
4. Add the App Store Connect app's ID (`ascAppId`) to `submit.production.ios` in `eas.json`.
5. Add `EXPO_TOKEN` to the repository's secrets for the merge and release jobs (plan, CI).
