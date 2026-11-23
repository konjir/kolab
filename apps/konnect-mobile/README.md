# konnect for iOS and Android

`@konjir/konnect-mobile`: konnect on a phone, for talking with the people and agents on your teams. It is an Expo SDK 58 app (React Native 0.88, React 19.3.0, Hermes, the New Architecture) in the root npm workspaces. The plan is [`docs/plans/konnect-mobile.md`](../../docs/plans/konnect-mobile.md). It has every phase of the plan, 0 to 6.

## What it does

- **Signing in:** while no team is signed in, the app is one screen with the Konjir wordmark and "Sign in with GitHub". That button opens Kolab's own page in the system's auth session, where the person picks a team, accepts an invitation or makes one. The app uses OAuth with PKCE, a client registered per sign-in at the variant's `<bundle ID>:/oauth` (the server's S1), and each team's tokens in the secure store. Each team refreshes one at a time, saving the rotated refresh token before using it, and signing out revokes at `/oauth/revoke`.
- **Home**, in Slack's order: the team (tap it for the team menu: its settings, inviting, notifications, switching and making teams) and a pencil for a new message, "Jump to…", Channels, Direct messages and Your agents, each thing once, with Unreads as a setting under You.
- **You:** the account, Home's Unreads, the theme (match the phone, Predawn or Daybreak), About, Sign out and Delete account (App Store guideline 5.1.1(v)): its own screen says what deleting does and takes the person's name typed; Kolab lists the teams that must be archived first (or their other members removed), and once it's done the phone is signed out; what the person sent stays, from an id that says nothing of them, shown as from "a deleted account". The brand's horizon lies along the bottom of every screen.
- **Conversations:** grouped messages, day separators, the New line, markdown for agents, pictures beside messages, a title that opens the channel's details or the person, replies, forwarding (to anyone but the sender) and copying, `@` and `#` completion, the 32,000-character count, and sends that show at once and keep a Retry. What scrolls into view is marked read.
- **Live and offline:** one listen stream per team keeps everything live while the app is open, and TanStack Query's cache is kept on the phone (expo-sqlite).
- **The other tabs:** DMs and Activity, which lists mentions, replies and capped messages.
- **Your agents:** on Home, each of your agents says what it did last and whether it needs you. Its own screen has its activity, its DMs (read-only, with a button to write to the other side; a long-press forwards) and its channels; anyone's agent has the same screen without them. Activity has a "Your agents" filter, a channel's details an "Only @you/bot" choice, and Notifications a setting per agent, kept by Kolab. A DM with an agent says who else can read it. The plan's "Your agents" has the whole of it.
- **Elsewhere:** browsing, making and following channels, profiles, team settings (invite, withdraw, remove, the reply cap, archive, delete, leave), and notification settings with push (phase 4).
- **Waiting on the server:** push waits for the server's S4 and for the EAS project. Read-up-to waits for S2, conversation lists for S3 and avatars for S5. The app uses each once Kolab has it, and until then says so or falls back.

Every operation is an Nx target, run from the repository root as `npx nx run @konjir/konnect-mobile:<target>`. Arguments after `--` go on to the command, such as `-- --platform ios`. Nx joins them into one command line for a shell, so a value with spaces doesn't survive: an update's message goes in `KONNECT_UPDATE_MESSAGE` instead.

## Develop

| Target | What it does |
| --- | --- |
| `prebuild` | `expo prebuild --clean`: writes `ios/` and `android/` from `app.config.ts`. Both are generated and gitignored (CNG). |
| `ios`, `android` | `expo run:ios`, `expo run:android`: a local dev build, installed on a simulator or emulator, with Metro. |
| `start` | `expo start --dev-client`: Metro, for a dev build that is already installed. |
| `local-kolab` | A throwaway Kolab from this checkout on `http://127.0.0.1:7432/mcp`, with the stub identity provider in GitHub's place. Team `hub` has Ann, Bo, Ann's agents `ann/reviewer` and `ann/helper` (which has DMs with Bo), Bo's agent `bo/builder`, two more channels, and unread messages for Ann. With `KONNECT_LOCAL_APPLE=1`, a stand-in for Sign in with Apple too, so Kolab's page shows both buttons, as production's does once Apple is set up; the Maestro flows run without it. |

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
| `submit` | `eas submit --profile production --latest`, run as `APP_VARIANT=production` |
| `update-preview`, `update-production` | `eas update --channel <channel>`, its message in `KONNECT_UPDATE_MESSAGE="…"` |
| `version` | `eas build:version:get` |
| `credentials` | `eas credentials` (interactive) |
| `credentials-production-ios`, `credentials-preview-ios`, `credentials-production-android`, `credentials-preview-android` | `eas credentials` for that app and platform, built as its `APP_VARIANT`. On iOS it signs in to Apple with the App Store Connect team key (`scripts/credentials.mjs`), whose `.p8` stays at `~/.config/konnect-mobile/AuthKey_<key id>.p8`, not the Apple ID sign-in that eas-cli 27.11.0 fails. Choose the same build profile when asked. |
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
| `submit-preview`, `submit-production` | `eas submit` of a local build, with `-- --platform … --path <file>`, run as that profile's `APP_VARIANT`: eas submit, unlike eas build, never applies a build profile's env, so `scripts/eas.mjs` refuses a submit whose `APP_VARIANT` isn't its profile's. |

`.github/workflows/mobile-release.yml` runs these targets:
- On each merge: the fingerprint, then a local build and submit only for a new fingerprint, then `update-preview`.
- By hand, behind `app-stores`: production builds and submit, or an update to production alone.

`.github/workflows/mobile-e2e.yml` runs the Maestro flows on a macOS runner when started by hand.

A local iOS build needs fastlane and CocoaPods, which GitHub's macOS runners have. On this Mac, `build-simulator-local` stopped at "Fastlane is not available", so for now dev and simulator builds here use the `ios` target.

### Release setup

What Lee does, in order, before the release workflows can ship anything. Until then they fail at the first step that needs it, and send nothing.

1. **Apple.** Enrol in the Apple Developer Program.
2. **App Store Connect.** Make two apps: `com.konjir.konnect` (konnect), and `com.konjir.konnect.preview` (konnect preview, for TestFlight internal testing only and never released). Each app's Apple ID is in `eas.json`'s `submit.production.ios.ascAppId` (6838005396) and `submit.preview.ios.ascAppId` (6838010869).
3. **iOS credentials.** Run `npx nx run @konjir/konnect-mobile:credentials-production-ios`, then `credentials-preview-ios`. Each is interactive, and signs in to Apple with Lee's App Store Connect team API key ("EAS", Admin), whose `.p8` is kept at `~/.config/konnect-mobile/AuthKey_V455KTM3J2.p8` (mode 600), outside the repo. eas-cli's Apple ID sign-in fails with eas-cli 27.11.0, so what only it can do is done on the web: the APNs key is made in the developer portal (Keys, Apple Push Notifications service, Sandbox & Production, Team Scoped) and uploaded on expo.dev (Credentials, iOS, each bundle ID, Push Key). The targets never keep an Apple ID password in the Keychain (`EXPO_NO_KEYCHAIN`). In each, set up:
   - a distribution certificate (one, shared: the preview run reuses production's) and that app's provisioning profile
   - the APNs key, for push (uploaded on expo.dev, as above; one team-scoped key serves both apps)
   - the App Store Connect API key, for `eas submit`: answer no to generating one, and give the same team key's path, Key ID and Issuer ID
4. **Google Play.**
   - A developer account, and the two apps `com.konjir.konnect` and `com.konjir.konnect.preview`.
   - Each app's first AAB must be uploaded by hand in Play Console; Google allows nothing else for a new app. Build it with `build-preview-local` or `build-production-local`.
   - Then a Google Cloud service account with release rights, its JSON key uploaded to EAS (`credentials-production-android` and `credentials-preview-android`, Google Service Account) rather than kept in the repo.
5. **Android push.** FCM v1 credentials, uploaded to EAS the same way.
6. **The Expo access token for CI.** On expo.dev (account settings, Access tokens), add a robot user `github-actions` with the Developer role, make it a token, and store that as the `EXPO_TOKEN` secret in both GitHub environments below (`gh secret set EXPO_TOKEN --env <environment> --repo konjir/kolab`, which asks for the value). A robot acts as itself rather than as Lee, and can be revoked alone.
7. **No update signing.** expo-updates code signing needs a paid EAS plan ("EAS Update code signing requires a subscription to the EAS Production or Enterprise plan"), and Lee chose the free one (2026-11-22). What that means:
   - Whoever can publish an update to the EAS project can run their own JavaScript in every installed app on that channel at its next launch, with no store review and no console step: Lee's Expo account, the `github-actions` robot's token, code merged to `main` (the preview Update job runs the repo's scripts with that token), or Expo itself. A build EAS submits with the App Store Connect key only reaches TestFlight, and still needs App Review to reach the store; an update doesn't.
   - That JavaScript has everything the app has, including each team's refresh token in the secure store, so it could take every user's Kolab sign-ins and act as them.
   - `EXPO_TOKEN` is the whole trust anchor, and `app-stores`'s required reviewer doesn't guard updates: the same token is in `app-preview`, which has no reviewer.
   - So: two-factor authentication on Lee's Expo account; a separate robot token for each environment, so either can be revoked alone; and a token rotated the moment it may have been seen.

   To publish an update by hand, set `APP_VARIANT` to the channel's variant and its message in `KONNECT_UPDATE_MESSAGE`; `scripts/eas.mjs` refuses a mismatched variant.
8. **GitHub environments:**
   - `app-preview`, limited to the `main` branch, holding `EXPO_TOKEN`.
   - `app-stores`, limited to the `main` branch, with Lee as its required reviewer, holding the same.
   - Not on either environment, but on the repository (Settings, Secrets and variables, Actions, Variables): the variable `KONNECT_ANDROID`, set to `on` once Google Play's apps, the Android upload keystore and the FCM key exist (steps 4 and 5). The production matrix is decided before a job's environment is attached, so only a repository variable counts. Until then `mobile-release.yml` ships iOS alone (Lee, 2026-11-22).
9. **No tag ruleset.** GitHub doesn't let a repository ruleset exempt GitHub Actions in this organization ("Actor GitHub Actions integration must be part of the ruleset source or owner organization"), and `native.mjs tag` must create and move `konnect-native/*` tags, so they aren't restricted beyond write access, which only Lee has. A forged tag can only make the release workflow skip a native build, which leaves an update for a runtime no binary has, reaching no one: it can't put anything on a phone.
10. **The sign-in link.** Production signs in through `https://www.konjir.com/konnect/app/oauth` and preview through `https://www.konjir.com/konnect/app/preview/oauth`, each a Universal Link and an App Link for its own app alone (`src/auth/app-links.ts`), so both need iOS 17.4 or later: the app's deployment target is 17.4 (expo-build-properties). On iOS each declares the associated domains `applinks:www.konjir.com` and `webcredentials:www.konjir.com`, which an auth session's https callback needs. Only the development build uses its private scheme, which Kolab takes only with `KONJIR_APP_DEV_SCHEMES=on`, as local-kolab starts it. www.konjir.com must serve two files naming the app:
    - an `apple-app-site-association` with Lee's Apple Team ID, giving `com.konjir.konnect` and `com.konjir.konnect.preview` each its own path, and listing both under `webcredentials`
    - an `assetlinks.json` with the Play app signing certificate's SHA-256

    Both values come from steps 1 and 4.
11. **Kolab's push.** A separate Expo access token, a second robot user's (`kolab-push`, Developer role), which Kolab uses to send pushes through Expo, stored as the SecureString SSM parameter `/konjir/konjir-test/expo-access-token` (Terraform output `expo_access_token_parameter`), which Kolab reads as `KONJIR_EXPO_ACCESS_TOKEN`; `KONJIR_PUSH_PREVIEW=off` keeps message words out of every push. It is a different token from step 6. Once Kolab has it, turn on "Enhanced security for push notifications" (Access tokens, Additional settings), so Expo sends a push only with this account's token; turned on before, it would refuse Kolab's pushes.

**What the phone keeps.** The sign-in is in the secure store, on this device only. Kolab's answers are kept for up to 7 days in expo-sqlite, so the app opens offline: messages, channels and members, one cache per person. That cache is cleared when the person signs out or Kolab ends the sign-in.

After the first build from CI, check expo.dev's usage page to see whether local builds count against the free plan's 15 + 15 builds a month.
