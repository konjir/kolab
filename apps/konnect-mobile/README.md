# konnect for iOS and Android

`@konjir/konnect-mobile`: konnect on a phone, for talking with the people and agents on your teams. It is an Expo SDK 58 app (React Native 0.88, React 19.3.0, Hermes, the New Architecture) in the root npm workspaces. The plan is [`docs/plans/konnect-mobile.md`](../../docs/plans/konnect-mobile.md). It has every phase of the plan, 0 to 6.

## What it does

- **Signing in:** while no team is signed in, the app is one screen with the Konjir wordmark and "Sign in with GitHub". That button opens Kolab's own page in the system's auth session, where the person picks a team, accepts an invitation or makes one. The app uses OAuth with PKCE, a client registered per sign-in at the variant's `<bundle ID>:/oauth` (the server's S1), and each team's tokens in the secure store. Each team refreshes one at a time, saving the rotated refresh token before using it, and signing out revokes at `/oauth/revoke`.
- **Home**, in Slack's order: the team switcher, "Jump to…", Unreads, Channels, Direct messages, Agents with their state, and a pencil for a new message.
- **Conversations:** grouped messages, day separators, the New line, markdown for agents, replies, copying, `@` and `#` completion, the 32,000-character count, and sends that show at once and keep a Retry. What scrolls into view is marked read.
- **Live and offline:** one listen stream per team keeps everything live while the app is open, and TanStack Query's cache is kept on the phone (expo-sqlite).
- **The other tabs:** DMs and Activity, which lists mentions, replies and capped messages.
- **Elsewhere:** browsing, making and following channels, profiles, team settings (invite, withdraw, remove, the reply cap, archive, delete, leave), and notification settings with push (phase 4).
- **Waiting on the server:** push waits for the server's S4 and for the EAS project. Read-up-to waits for S2, conversation lists for S3 and avatars for S5. The app uses each once Kolab has it, and until then says so or falls back.

Every operation is an Nx target, run from the repository root as `npx nx run @konjir/konnect-mobile:<target>`. Arguments after `--` go on to the command, such as `-- --platform ios` or `-- --message "Fix the composer"`.

## Develop

| Target | What it does |
| --- | --- |
| `prebuild` | `expo prebuild --clean`: writes `ios/` and `android/` from `app.config.ts`. Both are generated and gitignored (CNG). |
| `ios`, `android` | `expo run:ios`, `expo run:android`: a local dev build, installed on a simulator or emulator, with Metro. |
| `start` | `expo start --dev-client`: Metro, for a dev build that is already installed. |
| `local-kolab` | A throwaway Kolab from this checkout on `http://127.0.0.1:7432/mcp`, with the stub identity provider in GitHub's place. Team `hub` has Ann, Bo and Ann's agent `ann-reviewer`, two more channels, and unread messages for Ann. |

`APP_VARIANT` (`development` by default, `preview`, `production`) picks the app: its name, bundle ID and package (`com.konjir.konnect.dev`, `.preview`, or none), and URL scheme, which is the same name. The three install side by side. `KONNECT_URL` points a build at another Kolab; it defaults to `https://kolab.konjir.com/mcp`.

The app imports `@konjir/brand` and `@konjir/types` as TypeScript source, through the `@konjir/source` export condition: `metro.config.js`, `jest.config.js` and `tsconfig.json` each name it. Metro also resolves the libraries' NodeNext-style `./x.js` imports to `./x.ts`. The brand's fonts (Fraunces, Instrument Sans and JetBrains Mono, from `@expo-google-fonts`) are embedded at build time by the `expo-font` config plugin.

### Trying it on the simulator

```sh
npx nx run @konjir/konnect-mobile:local-kolab                                   # a Kolab with something in it
KONNECT_URL=http://127.0.0.1:7432/mcp npx nx run @konjir/konnect-mobile:start   # Metro, pointed at it
npx nx run @konjir/konnect-mobile:ios                                            # once: build and install the dev client
```

1. Tap "Sign in with GitHub".
2. The local Kolab signs anyone in as Ann. On its page, tap "Sign in to hub".
3. `nx run @konjir/konnect-mobile:e2e` runs the Maestro flows in `.maestro/` (sign-in, messaging, making a team, team admin) against the same setup. It starts signed out, on a freshly started `local-kolab`.

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

iOS asks whether to open each link in the app; tap Open. The spikes are there only while signed in to a team, in the development variant. Each spike logs to the screen and to Metro. `local-kolab` hands the build its URL and two throwaway tokens at `http://127.0.0.1:7433/spike`, on loopback only. Never point the spikes at production.

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
| `e2e` | The Maestro flows in `.maestro/` against an installed build. Maestro is installed apart from npm, into `~/.maestro`, and needs Java 17 or later. |

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

### Builds and releases on the free plan

The EAS project is `@icedlee337/konnect` (`EAS_PROJECT_ID` and `EAS_OWNER` in `app.config.ts`). Binaries are built with `eas build --local` on GitHub's runners, and an over-the-air update ships whenever the native code hasn't changed. The plan's "Distribution and builds" says why.

| Target | What it does |
| --- | --- |
| `native-check` | Each platform's native fingerprint for `--profile`, and whether a binary exists for it: a git tag `konnect-native/<profile>/<platform>/<fingerprint>`. |
| `native-verify` | Checks that a built `.ipa` or `.aab` embeds exactly this checkout's fingerprint, in the file expo-updates reads it from at launch: `EXUpdates.bundle/fingerprint` in the app bundle, or the asset `fingerprint` (`base/assets/fingerprint`). Expo.plist and the manifest hold only `file:fingerprint`. |
| `native-tag` | Records the binary just built, by pushing that tag. The release workflow runs `scripts/native.mjs tag` directly instead, with nothing installed, since that job can write to the repo. |
| `build-preview-local`, `build-production-local` | `eas build --local` for that profile, with `-- --platform ios\|android --output <file>`. |
| `build-dev-local`, `build-simulator-local` | A dev client, or one for the iOS simulator, built on this machine. |
| `submit-preview`, `submit-production` | `eas submit` of a local build, with `-- --platform … --path <file>`. |

`.github/workflows/mobile-release.yml` runs these targets:
- On each merge: the fingerprint, then a local build and submit only for a new fingerprint, then `update-preview`.
- By hand, behind `app-stores`: production builds and submit, or an update to production alone.

`.github/workflows/mobile-e2e.yml` runs the Maestro flows on a macOS runner when started by hand.

A local iOS build needs fastlane and CocoaPods, which GitHub's macOS runners have. On this Mac, `build-simulator-local` stopped at "Fastlane is not available", so for now dev and simulator builds here use the `ios` target.

### Release setup

What Lee does, in order, before the release workflows can ship anything. Until then they fail at the first step that needs it, and send nothing.

1. **Apple.** Enrol in the Apple Developer Program.
2. **App Store Connect.** Make two apps: `com.konjir.konnect` (konnect), and `com.konjir.konnect.preview` (konnect preview, for TestFlight internal testing only and never released). Put each app's Apple ID in `eas.json`'s `submit.production.ios.ascAppId` and `submit.preview.ios.ascAppId`. The submit targets refuse while those say `REPLACE_WITH_…`.
3. **iOS credentials.** In this folder run `npx eas credentials`, which is interactive and signs in with Lee's Apple account:
   - a distribution certificate and provisioning profile for each bundle ID
   - the APNs key, for push
   - an App Store Connect API key, for `eas submit`
4. **Google Play.**
   - A developer account, and the two apps `com.konjir.konnect` and `com.konjir.konnect.preview`.
   - Each app's first AAB must be uploaded by hand in Play Console; Google allows nothing else for a new app. Build it with `build-preview-local` or `build-production-local`.
   - Then a Google Cloud service account with release rights, its JSON key uploaded to EAS (`npx eas credentials`, Android, Google Service Account) rather than kept in the repo.
5. **Android push.** FCM v1 credentials, uploaded to EAS the same way.
6. **The Expo access token for CI.** Make one on expo.dev and store it as the `EXPO_TOKEN` secret in both GitHub environments below. A personal Expo account has no robot users, so this is Lee's own token, acting as Lee.
7. **The update signing key.** Updates are signed (expo-updates code signing). A build applies only an update signed with the key whose certificate it carries, `certs/certificate.pem`, which is in the repo. The private key was made with the certificate and is kept outside the repo, on Lee's machine, at `~/.config/konnect-mobile/updates-signing/private-key.pem` (mode 600). Store its contents as the `KONNECT_UPDATES_PRIVATE_KEY` secret in both environments below. Never commit it. To publish an update by hand, set `KONNECT_UPDATES_PRIVATE_KEY_PATH` to that file and `APP_VARIANT` to the channel's variant; `scripts/eas.mjs` refuses otherwise.
8. **GitHub environments:**
   - `app-preview`, limited to the `main` branch, holding `EXPO_TOKEN` and `KONNECT_UPDATES_PRIVATE_KEY`.
   - `app-stores`, limited to the `main` branch, with Lee as its required reviewer, holding the same two.
9. **A tag ruleset.** It lets only GitHub Actions create or move `konnect-native/*` tags, since they tell the release workflow which binaries exist.
10. **The sign-in link.** Production signs in through `https://www.konjir.com/konnect/app/oauth` and preview through `https://www.konjir.com/konnect/app/preview/oauth`, each a Universal Link and an App Link for its own app alone (`src/auth/app-links.ts`), so both need iOS 17.4 or later: the app's deployment target is 17.4 (expo-build-properties). On iOS each declares the associated domains `applinks:www.konjir.com` and `webcredentials:www.konjir.com`, which an auth session's https callback needs. Only the development build uses its private scheme, which Kolab takes only with `KONJIR_APP_DEV_SCHEMES=on`, as local-kolab starts it. www.konjir.com must serve two files naming the app:
    - an `apple-app-site-association` with Lee's Apple Team ID, giving `com.konjir.konnect` and `com.konjir.konnect.preview` each its own path, and listing both under `webcredentials`
    - an `assetlinks.json` with the Play app signing certificate's SHA-256

    Both values come from steps 1 and 4.
11. **Kolab's push.** A separate Expo access token, which Kolab uses to send pushes through Expo, stored as the SecureString SSM parameter `/konjir/konjir-test/expo-access-token` (Terraform output `expo_access_token_parameter`), which Kolab reads as `KONJIR_EXPO_ACCESS_TOKEN`; `KONJIR_PUSH_PREVIEW=off` keeps message words out of every push. It is a different token from step 6.

**What the phone keeps.** The sign-in is in the secure store, on this device only. Kolab's answers are kept for up to 7 days in expo-sqlite, so the app opens offline: messages, channels and members, one cache per person. That cache is cleared when the person signs out or Kolab ends the sign-in.

After the first build from CI, check expo.dev's usage page to see whether local builds count against the free plan's 15 + 15 builds a month.
