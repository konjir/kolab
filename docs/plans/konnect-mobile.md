# Plan: konnect for iOS and Android

Lee's instruction of 2026-11-21: a React Native app that lets a person use konnect from a phone, talking with the people and agents on their teams, with Slack as the model for its information architecture and UX. It is distributed through EAS (Expo Application Services). Every operation is an Nx target, with no Nx plugins, and the app uses Expo libraries wherever one exists. `~/github.com/Ivim-Health/ivim/apps/native/myvim` is the example setup, and improvements on it are welcome.

Like konnect itself, this runs outside the kolab's planning process: no spec or binding versions and no work packages. This file is its plan. Pull requests, CI, independent review of security-sensitive changes, reading the Terraform plan before a deploy and the database snapshot before a migration still apply (CLAUDE.md, *Working in this repo*).

## What exists today

**The client surface is MCP.** konnect is a client of Kolab's MCP endpoint, `https://kolab.konjir.com/mcp`, over stateless Streamable HTTP. Every operation is a `tools/call`, and results come back in `structuredContent`. The tools a phone needs already exist:
- messages: `konjir_send_message`, `konjir_read_messages`, `konjir_list_messages`
- channels: `konjir_list_channels`, `konjir_make_channel`, `konjir_follow_channel`, `konjir_unfollow_channel`, `konjir_send_channel_message`, `konjir_read_channel`, `konjir_list_channel_messages`
- members and agents: `konjir_list_members` (each member's `kind`, `owner`, `label`, `here` and agent `state`), `konjir_whoami`
- team: `konjir_invite`, `konjir_list_invitations`, `konjir_withdraw_invitation`, `konjir_remove_member`, `konjir_remove_agent`, `konjir_leave_kolab`, `konjir_archive_kolab`, `konjir_erase_kolab`, `konjir_set_agent_reply_cap`

**Real time is `subscriptions/listen`.** The client opens a listen stream on one resource per person, `konjir://answers/<kolab>/<actor>`. The server sends `notifications/resources/updated` and the client re-reads the resource; the notification carries no content. A stream lasts as long as its 15-minute access token, so the client reconnects after each refresh. Underneath, the engine's `kolab.onEvent` fires for every recipient of every DM and channel message, across server processes, through Postgres `LISTEN/NOTIFY`.

**Sign-in is OAuth 2.1 with PKCE.** The server publishes discovery metadata, accepts dynamic client registration and issues rotating refresh tokens: access lasts 15 minutes, and a grant lasts 30 days from its last refresh. A person grant ends that person's earlier session on the same client, so the client registers once per team, as konnect does with one file per team.

**Limits:**
- 32,000 characters and 20 mentions per message
- 200 channels per team
- reads return 20 at a time, and lists 50 by default, up to 200
- 240 messages an hour, shared by a person and their agents

**What is missing for a Slack-like app:**
- **Native redirects.** Redirect URIs must be `https` or loopback, so a custom scheme is refused. The sign-in flows that pick a team, accept an invitation or create a team accept only loopback clients, so a phone could sign in to an existing team but couldn't join or make one.
- **Marking read.** A channel has one read position per member, and DMs have a receipt per message, but the only way to move either is to consume messages oldest first, 20 per call. There is no "read up to here".
- **A DM list.** There is no per-conversation unread for DMs, only a team total and the oldest 20 unread items.
- **Push.** Nothing exists: no device tokens, no APNs, no FCM. iOS ends a background listen stream, so without push a phone hears nothing while the app is closed.
- **Display.** Members are actor ids, with no display name or avatar.
- **Threads.** A message has a single `reply_to`, with no reply count or thread list.
- **By design:** messages can't be edited or deleted, because database triggers keep `message` and `channel_message` append-only. There is also no search, reactions, attachments or typing.
- **The web app** has no konnect UI, and `/mcp` sends no CORS headers. A native app sends no `Origin`, so it is allowed; Expo web isn't, and is out of scope.

## Decisions

| Decision | Recommendation | Taken |
| --- | --- | --- |
| How the app gets its OAuth callback | A first-party private-use scheme per app variant (RFC 8252 §7.1), `com.konjir.konnect:/oauth`, allowed by name on the server. That scheme also gets the team-choosing, invitation and team-creating flows that loopback clients have. Universal links are the alternative: they need an `apple-app-site-association` and `assetlinks.json` file on a konjir.com domain, plus https callbacks in the auth session, which is more moving parts for no gain in safety for a public client. | Lee |
| What a push notification shows | The sender, the channel and the first 100 characters, with a setting on the device to hide the text. The text passes through Expo's push service and Apple or Google. | Lee |
| Accounts | An Expo organization `konjir` that owns the EAS project. The bundle ID and package are `com.konjir.konnect`, with `.dev` and `.preview` variants. The Apple Developer team and Google Play account are Lee's. | Lee |
| React version | Pin `react` and `react-dom` at root to the version the Expo SDK pins (19.3.0 for SDK 58; web is on ^19.3.1). That keeps one copy and one lockfile. | Lee |
| Store releases | A `workflow_dispatch` job behind a GitHub environment `app-stores` with Lee as its required reviewer, as with deploys. Preview builds and over-the-air updates to the preview channel go out on merge without approval. | Lee |
| The app's name | konnect | Lee |

## Setup

### Project and versions
- **Location:** the app is `apps/konnect-mobile` (`@konjir/konnect-mobile`) in the root npm workspaces: one lockfile and one install, so CI builds and tests it. myvim has its own lockfile per app and lib and is skipped by CI (its ADR-0003); this layout avoids that.
- **Stack:** Expo SDK 58 (`expo` 58.0.x on npm today), React Native 0.88 and React 19.3.0. Hermes and the New Architecture are SDK 58's defaults. Node 24 meets the SDK's engines.
- **Native folders:** Continuous Native Generation. `ios/` and `android/` are generated and gitignored, and all native config is in `app.config.ts` and config plugins. myvim commits them, and they have drifted from its config (a missing calendar permission, missing Android resources), so EAS builds it as a bare app and ignores its config.
- **Config:** `app.config.ts` only, with no `app.json`. `APP_VARIANT` (`development`, `preview`, `production`) sets the name, bundle ID, scheme and icon, so all three install side by side.

### Shared code and resolution
- **One mechanism:** the libs' `@konjir/source` export condition, the one tsconfig and tsx already use. Metro gets `resolver.unstable_conditionNames` with `@konjir/source` (package exports are on by default), and Jest gets `testEnvironmentOptions.customExportConditions`. myvim keeps three alias lists, for tsconfig, Metro and Jest, and they have drifted; one condition replaces all three.
- **`libs/konnect-client`** (new) holds the platform-neutral half of `apps/konnect/src`: typed wrappers over the tools and the answers resource, name parsing (`#channel`, `@member`, `@owner/name`), mention matching, and the listen loop with reconnection and the 30-second `konjir_whoami` liveness check. It takes an MCP `Client` and a `fetch`. The konnect CLI moves onto it unchanged, with its tests and `konnect-compat` as the guard. `libs/login` stays Node-only, since its loopback listener can't run on a phone.
- **Brand:** `libs/brand` supplies the colour and type tokens. The fonts the web app uses (Fraunces, Instrument Sans, JetBrains Mono) are embedded at build time with the `expo-font` config plugin, rather than loaded at run time as myvim does.

### Libraries
**Expo:**

| Library | Use |
| --- | --- |
| `expo-router` | Routes, typed routes, native tabs and deep links |
| `expo-auth-session` and `expo-web-browser` | OAuth with PKCE, and opening links in messages |
| `expo-secure-store` | Refresh tokens and client registrations, one per team |
| `expo-sqlite` (`kv-store`) | The offline cache and preferences |
| `expo-notifications` and `expo-device` | Push |
| `expo-updates` | Over-the-air updates |
| `expo-dev-client` | Development builds |
| `expo-image` | Avatars |
| `expo-haptics` | Haptics |
| `expo-clipboard` | Copying a message |
| `expo-symbols` | Icons, with `@expo/vector-icons` where a symbol is missing on Android |
| `expo-splash-screen`, `expo-status-bar`, `expo-system-ui` | Launch and system chrome |
| `expo-network` | Online state |
| `expo-localization` | Dates and times |
| `expo-application` and `expo-constants` | The version header and config |
| `expo/fetch` | The streaming fetch that the listen stream needs |

**Not Expo, because Expo has no equivalent:**
- `@modelcontextprotocol/client`, as the CLI uses
- `@tanstack/react-query`, for the server cache, refetching on focus and invalidating on each resource update. myvim's Redux thunks and hand-written hooks don't fit a "re-read on notify" API.
- `@shopify/flash-list`, which SDK 58 bundles
- a markdown renderer for agents' messages
- `jest-expo` and `@testing-library/react-native` for tests, and Maestro for end-to-end tests

### Nx targets
The targets are `package.json` scripts plus an `nx` block of `nx:run-commands`, as the other projects here have, with no `@nx/expo`, `@nx/react-native` or other plugin. `eas-cli` is a pinned devDependency, run with `npx eas`, never a global install. Targets that build or publish forward `--platform` and `--message`.

**Develop:**

| Target | Runs |
| --- | --- |
| `start` | `expo start --dev-client` |
| `ios`, `android` | `expo run:ios`, `expo run:android` (a local dev build) |
| `prebuild` | `expo prebuild --clean` (outputs `ios/`, `android/`) |

**Check:**

| Target | Runs |
| --- | --- |
| `typecheck` | `tsc -p tsconfig.json` (cached) |
| `lint` | `expo lint` (cached) |
| `test` | `jest` with `jest-expo` (cached) |
| `doctor` | `expo-doctor` |
| `deps-check` | `expo install --check` |
| `fingerprint` | `expo-updates fingerprint:generate` |
| `bundle-scan` | `expo export`, then a scan of the bundle for anything that looks like a token or secret |
| `e2e` | `maestro test .maestro` against a dev or preview build |

**Build, release and look after the EAS project:**

| Target | Runs |
| --- | --- |
| `build-dev` | `eas build --profile development` (a dev client; a `simulator` configuration builds for the iOS simulator) |
| `build-preview` | `eas build --profile preview` (internal distribution) |
| `build-production` | `eas build --profile production --auto-submit` |
| `submit` | `eas submit --profile production --latest` |
| `update-preview`, `update-production` | `eas update --channel <channel> --message …` |
| `version` | `eas build:version:get` |
| `credentials` | `eas credentials` (interactive) |
| `eas-whoami` | `eas whoami` |
| `env-pull` | `eas env:pull --environment <env>` |

### EAS
**`eas.json`:**
- `cli.version` is pinned, with `appVersionSource: remote`.
- There are three profiles, each with its own channel:
  - `development`: `developmentClient`, internal distribution, plus a `development-simulator` profile.
  - `preview`: internal distribution, through TestFlight internal testing and Play internal testing.
  - `production`: store distribution with `autoIncrement`.
- The `submit.production` profile names the App Store Connect app and the Play track.
- `node` is pinned to the repo's version.

**Environment:** variables live in EAS environments, not in `eas.json`. Only public config ships: `KONNECT_URL`, which defaults to `https://kolab.konjir.com/mcp`, and a dev build can point it at a local server on the LAN.

**Updates:** `runtimeVersion: { policy: 'fingerprint' }`, so an update reaches only the builds whose native code it matches.

**CI** (`.github/workflows/mobile.yml`):
- **On a pull request that touches the app or its libs:** `typecheck`, `lint`, `test`, `doctor`, `deps-check` and `bundle-scan`.
- **On merge to main:** compare the fingerprint with the last preview build's. If it matches, run `update-preview`; if not, run `build-preview`.
- **Store releases:** a manual run behind the `app-stores` environment runs `build-production`, then `submit`. A JS-only fix to production is `update-production`, run the same way.
- **Secrets:** `EXPO_TOKEN` is a GitHub secret.

## Distribution and builds

Lee's decisions of 2026-11-21: the EAS project is `@icedlee337/konnect`, owned by his personal Expo account, and iOS testers use TestFlight. Everything is built to fit Expo's free plan:
- 15 Android and 15 iOS cloud builds a month, on a low-priority queue, with no overage.
- 60 EAS Workflows minutes, whose build jobs count against the same quota. EAS's Maestro jobs aren't on the free plan.
- Updates are free up to 1,000 monthly active users. Submit is included, and the push service isn't billed.

**Builds run on GitHub's runners, not EAS's.** The repo is public, so GitHub's macOS and Linux runners are free.
- Binaries are built with `eas build --local`:
  - iOS on `macos-15`, with Xcode 26.2 selected, the version the expo-modules-jsi patch is made for.
  - Android on `ubuntu-24.04`, with JDK 17 and the runner's Android SDK.
- Signing credentials stay EAS-managed, fetched with `EXPO_TOKEN`.
- The cloud `build-*` targets remain as a fallback.
- Dev clients and simulator builds are made on Lee's Mac with the `ios` target, or with `build-dev-local` and `build-simulator-local`.
- Neither EAS Workflows nor EAS's Maestro jobs are used. `.github/workflows/mobile-e2e.yml` runs the Maestro flows on a macOS runner by hand, against a local Kolab, with no secrets.
- Whether local builds count against the build quota is to be checked on expo.dev's usage page after the first run. The billing FAQ points to local builds when the quota runs out.

**Each merge to main that touches the app or its libraries goes through a fingerprint gate** (`.github/workflows/mobile-release.yml`):
1. `native-check` works out each platform's native fingerprint for the preview profile.
2. A binary for a fingerprint is recorded as the git tag `konnect-native/<profile>/<platform>/<fingerprint>`, which the build job pushes once its binary is submitted. EAS records only its own builds: a local build leaves nothing in `eas build:list` for `eas fingerprint:compare` to compare against.
3. A platform whose fingerprint has a binary gets nothing new.
4. A platform without one gets a local preview build, submitted with `eas submit --path`, then tagged.
5. Either way, `update-preview` publishes an over-the-air update on the preview channel. It is free, and every binary with that fingerprint picks it up.

**Where builds go:**
- **iOS preview:** TestFlight internal testing. The preview profile has store distribution, and `com.konjir.konnect.preview` is its own App Store Connect app, which is never released.
- **Android preview:** Play's internal testing track for `com.konjir.konnect.preview`. Google requires the first AAB of a new app to be uploaded by hand in Play Console.
- **Production:** TestFlight and Play's internal track for `com.konjir.konnect`. Promoting to the stores is a manual step in the consoles.
- **Production release:** a `workflow_dispatch` behind the `app-stores` environment, with Lee as its required reviewer. It runs the local production builds and submits them, or with `update-only`, publishes an update on the production channel.

**Secrets.** The repo is public, so:
- `EXPO_TOKEN` lives only in the `app-preview` environment (main only) and the `app-stores` environment.
- Only jobs on a push to main or a `workflow_dispatch` read it, never on a pull request, so a fork's run gets nothing. Pull request checks have no secrets.
- Each job holds only the permissions it needs. The build jobs alone may write, to push their tag.
- Actions are pinned to commit SHAs.
- `EXPO_TOKEN` is a robot user's token (`github-actions`, Developer role), not Lee's own: personal Expo accounts have robot users too.

Every step is an Nx target of `@konjir/konnect-mobile`, and the workflows only run `npx nx run @konjir/konnect-mobile:<target>`, but for the jobs that push the tag: they can write to the repo, so they install nothing and run `node apps/konnect-mobile/scripts/native.mjs tag` on the runner's Node. They tag each platform that was built, even when the other failed. The README's "Release setup" lists what Lee sets up, in order.

## Information architecture (Slack's, mapped onto konnect)

| Slack | konnect |
| --- | --- |
| Workspace | Team. Each team is its own sign-in, and a switcher at the top lists them all with an unread dot on each. |
| Channels | Channels. All are public; you follow or unfollow them, and `#general` always exists. |
| Direct messages | DMs with people and with agents |
| Apps / bots | Agents (`@owner/name`), in a section of their own, each with a state dot: working, running, idle, or not running |
| Threads | Replies (`reply_to`). They show inline as a quote of the parent at first, and get a thread view once the server lists replies (S6). |
| Mentions & reactions / Activity | Activity: mentions of you, replies to you, and messages your mention left unwoken because an agent was past its cap |
| Huddles, files, reactions, edit or delete | None. Edit and delete are refused by design. |

**Tabs, native through expo-router:**

| Tab | What it shows |
| --- | --- |
| **Home** | Four sections: Unreads (optional), Channels you follow, Direct messages, Agents. Unread conversations are bold with a badge for mentions. At the end: "Browse channels" and "New message". |
| **DMs** | Every conversation, most recent first, each with its last message |
| **Activity** | As above |
| **You** | Your teams and sign-ins, notification settings, and the app's version and update channel |

**Screens:**
- **Conversation:**
  - The message list: an inverted FlashList, grouped by sender and minute, with day separators and a "New" line at your read position.
  - Agents' messages are rendered as markdown. A capped message is marked as not having woken anyone.
  - Long-press a message to Reply or Copy.
  - Unread messages are marked read as they are scrolled past (S2).
- **Composer:**
  - `@` autocompletes people and agents, and `#` completes channels.
  - A character count appears near 32,000.
  - A message that couldn't be sent stays, with Retry.
  - Sent messages show at once and are reconciled when the server returns its id.
- **Channel details:** who made it and when, Follow, and the team's agent reply cap (only the owner can change it).
- **Profile:** person or agent. For an agent: its owner, its state and whether it is signed in. Every profile has a Message button.
- **Browse channels:** every channel, with Follow or Unfollow, and Create.
- **Team settings:**
  - Invite by GitHub username, pending invitations, remove a member or agent.
  - Owner only: the reply cap, Archive and Delete. Both need the team's name typed to confirm.
- **Sign in, or add a team:** the server's consent page in the auth session, for an existing team, an invitation or a new team.

**Live updates:** while the app is in the foreground, it holds one listen stream per signed-in team. Each update invalidates that team's queries for the answers resource and the open conversation. The streams close in the background and reopen, with a refetch, when the app comes back. In the background, push takes over.

**Your agents** (Lee, 2026-11-22, in #211). A person sees what their own agents say and hear. Kolab's owner tools serve it: `konjir_list_my_agents_status`, `konjir_agent_activity`, `konjir_list_agent_conversations` and `konjir_list_agent_messages`. An agent `Member` has `owner_reads`, and DM results say who else can read them. Reading never marks anything read for the agent, and the owner's listen stream is signalled on the agent's traffic. The app's adapter is `src/kolab/agents.ts`.
1. **Home's Agents section.** Your own agents come first. Each shows its state dot and one line of what it did last ("replied to @bo in #general · 2m"), with a "needs you" badge when an unread mention, a capped message, or unread messages while it isn't running wait. Other people's agents show their state only, and open their profile.
2. **The agent screen.** A header with its name, state and whether it is here, and a **Message @you/bot** button (your own DM with it). Three tabs:
   - **Activity**: the live timeline, each row labelled with where it was ("#general", "DM with @bo"). A tap opens that conversation.
   - **Conversations**: its DMs.
   - **Channels**: where it is active, with its unread backlog.

   Someone else's agent shows only its profile and a Message button.
3. **Reading one of its DMs.** The conversation screen, with the banner "@you/bot's conversation with @bo · read-only". In place of the composer there are two buttons: **Message @bo yourself**, and **Tell @you/bot**, which opens your DM with the agent. Nothing is marked read.
4. **Activity tab.** A "Your agents" filter: DMs to your agents, mentions of them, capped messages, and agents not running with messages waiting.
5. **Notifications.** Per agent: never, when it's stuck or capped (the default), or every message to it, in Kolab's notification prefs (`agents`). A push about an agent opens its DM read-only, the channel on its messages, or its screen.
6. **Channels.** An "Only @you/bot" filter in a channel where one of your agents has spoken.
7. **Disclosure.** In any DM with an agent, a small, permanent line under the header: "@owner, its owner, can read this conversation", driven by Kolab's fields. That includes DMing someone else's agent, and isn't shown to the owner.

## Server work

This work is in this repo and outside the kolab process, like konnect. New tools keep the `konjir_` prefix that the server's other tools use.

**S1. Native sign-in.** Security-sensitive, so it gets an independent review.
- Allow redirect URIs on the first-party schemes `com.konjir.konnect`, `com.konjir.konnect.dev` and `com.konjir.konnect.preview`, by name and not any scheme. `validRedirectUri` already rejects fragments and credentials.
- Let `formActionSource` allow those schemes, so the consent page's 303 isn't blocked by `form-action`.
- Let clients whose redirects are all on those schemes use the person scopes that are loopback-only today: `choose:kolab` and `team:<name> intent:join|create`.
- Tests cover a look-alike scheme (`com.konjir.konnect.evil`), mixed redirect lists and replays.

**S2. Mark read.**
- `konjir_mark_channel_read {channel, up_to}` moves your read position forward, never back.
- `konjir_mark_messages_read {with, up_to}` sets receipts on DMs from `with` up to that id.
- Both are person and agent tools, scoped to the caller.

**S3. Conversations.** `konjir_list_conversations {cursor?, limit?}` lists one row per DM partner: the last message, an unread count capped at 1000 with `unread_more`, and a time to sort by, newest first.

**S4. Push.**
- Migration `push_device` (actor, Expo push token, platform, created and last-seen times) with RLS and archive triggers, like `message`.
- Tools: `konjir_register_push_device {token, platform}`, `konjir_unregister_push_device {token}`, and `konjir_set_notification_prefs`. The prefs are per team: `all`, `mentions_and_dms` (the default) or `none`, plus a list of muted channels.
- A subscriber on `kolab.onEvent` queues one outbox job for each person with a device, a message they'd want to hear about and no stream open. The outbox gives retries and backoff. The job sends through Expo's push API and drops tokens that come back `DeviceNotRegistered`.
- The payload carries what the push decision set (sender, channel, a 100-character preview or none), the team, the conversation and the message id for the deep link, and the badge count.
- Terraform: the Expo access token as an SSM SecureString, read by the instance role.

**S5. Display.** `Member` gets `login`, the GitHub username, so the app can show `https://github.com/<login>.png` through `expo-image` with a disk cache. An agent shows its owner's avatar with an agent badge.

**S6. Later: threads.** `konjir_list_replies {channel | with, message}`, and `reply_count` on list results.

**S7. Later: starting and stopping agents from the phone.**
- This uses the existing host tools. The phone implements `seal.ts`: HKDF-SHA256, then AES-256-GCM, using `expo-crypto` if it does AES-GCM on SDK 58 and `@noble/ciphers` if not.
- It keeps each machine's pairing code in the secure store.
- Making a new agent's login stays on the machine, since that setup flow is loopback-only.

## Phases

Every phase, 0 to 6, ships in one PR, #211 (Lee, 2026-11-21), each phase in its own commits, merged after review and green CI; its server changes deploy as usual. "Later" stays out of it.

0. **Spikes (1–2 days).** Prove each of these, or change the plan:
   - `@modelcontextprotocol/client` runs on Hermes, with `expo/fetch` streaming a listen response.
   - The repo's TypeScript 7 works with Expo's tooling. If it doesn't, the app pins its own TypeScript 5.9 for `typecheck`.
   - The auth session completes against a local server running S1 behind a flag.
   - `expo-symbols` covers the Android icons.
1. **Scaffold.**
   - `apps/konnect-mobile` with every target above, the CNG config, the three variants, `eas.json` and `mobile.yml`'s pull request checks.
   - `libs/konnect-client`, extracted, with the CLI on it.
   - The EAS project linked (Lee: Expo organization, Apple team, Play account), and a dev build on a phone.
2. **Sign-in and teams.** S1 and S5. Sign in, add a team, accept an invitation, create a team, the team switcher and sign out (revoke). Tokens refresh across all teams, one refresh per team at a time.
3. **Messaging.** S2 and S3:
   - Home, DMs, the conversation and the composer, with mentions.
   - Browse, create and follow channels.
   - Profiles, the agents section with states, and live updates.
   - The offline cache.
   - Maestro flows for sign-in, sending a message and DMing an agent.
4. **Push.** S4:
   - Ask for permission after the first sign-in, not at launch.
   - Notification settings, and deep links from a notification into the conversation.
   - The badge count. Taking the token back on sign-out.
5. **Team admin and Activity.** Invites, invitations, removing members, the reply cap, and leave, archive and delete. The Activity tab.
6. **Release.**
   - The store listings and privacy details (`ios.privacyManifests`; the push text decision).
   - Preview builds to internal testers, then the first production submit behind `app-stores`. From then on, JS changes ship as over-the-air updates.

**Later:** threads (S6); starting and stopping agents from the phone (S7); leases; an iPad split view; search (a server question first); a queue of sends made offline.

## Improvements on myvim, in short

- **Native folders:** generated (CNG) and gitignored, where myvim commits them and they have drifted.
- **Development builds:** `expo-dev-client` is installed. myvim's dev profile expects it but doesn't have it.
- **Updates:** EAS Update with fingerprint runtime versions and one channel per profile. myvim has no updates and no channels.
- **Variants:** the variants install side by side. myvim has one bundle ID for every environment.
- **Packages:** one workspace and one lockfile, so CI covers the app. myvim has a lockfile per app and lib, and CI skips its native apps.
- **Resolution:** one export condition for TS, Metro and Jest, where myvim keeps three alias lists.
- **Targets:**
  - Explicit targets for everything, including submit, update and fingerprint, with `eas-cli` pinned, not installed globally.
  - A real `typecheck` (myvim's is a no-op) and one `test` target, not two.
  - `bundle-scan` and the checks run in CI, where myvim's are manual or missing.
- **Fonts:** embedded at build time.
- **Sign-in:** OAuth with PKCE, not a password sent to the app's own API.
- **Push:** from the start.

## Found along the way

- konnect's man page says the agent reply cap counts "100 agent messages in a row in a channel". The server counts each agent's messages across the whole team, DMs to agents included, and resets on any person's message (`kolab.ts:10319-10345`). One of them should change.
- `konnect send --reply <id>` works but isn't in the man page.
