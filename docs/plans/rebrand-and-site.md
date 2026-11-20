# Plan: @konjir/kolab, and konjir.com split by product

Lee's instruction of 2026-11-18. This work runs outside the kolab's planning process, as konnect's does: it isn't planned in `kj:kolab/kolab-binding` and has no work packages or rulings there. This file is its plan. Pull requests, CI, independent review on security-sensitive changes, reading the Terraform plan before approving a deploy, and the database snapshot before a migration still apply (CLAUDE.md, *Working in this repo*).

Where this plan contradicts the kolab (D11, D63, D81, D94; the binding's API6, IMP2, API14, API25, API29 and DEP8), this plan wins for this work. Reconciling the kolab afterwards is a separate decision of Lee's.

## Status, 2026-11-20

Shipped and deployed:
- The konnect guard (#179): the server logs each client's name and version, and CI runs every published konnect against every server change.
- Step 1a (#180): the CLI is `@konjir/kolab`, command `kolab`. 0.9.0 is on npm, published by the workflow with provenance, and the web page's `npx` line names it (#185).
- Step 1b (#186): the server says `kolab`; errors and sign-in pages do only for a client that says it is kolab.
- Step 2 (#178): www.konjir.com with `/`, `/kolab/`, `/konnect/`; konjir.com serves the same pages, and the old paths redirect.
- Steps 3–5 (#183, #182, #184, #181): the org page, the reworked Kolab page with its working mark demo, `/kolab/how-it-works/`, and the konnect page. The tutorial installs `@konjir/kolab` (#188).
- Step 6 (#191, #190): footer links to source, npm and licences; a one-row header at any width; a signed-out view on kolab.konjir.com.
- Also: every `kolab` subcommand answers `--help` without acting (#187); CI's test jobs have room (#189).

Left:
- Lee: release 0.9.1, so the published CLI has the `--help` fix (in 0.9.0, `kolab logout --help` signs out). Then the tutorial's install line and `cli_npm_spec` move to it.
- Lee: the text of a privacy policy and terms, and a contact, for the footer.
- Follow-ups: the site's media queries in `min-width`/`max-width` form, for Safari before 16.4; the web page's retry sends one stale request per press (apps/web/src/api.ts `patiently`); konnect's `hosts` and `review` tests time out now and then on CI's Postgres job.
- Later, Lee's call: konjir.com redirecting to www once old cached redirects have aged out; reconciling the kolab (D11, D63, D81, D94 and the binding elements above).

## Decisions

| Decision | Taken |
| --- | --- |
| The npm package `konjir` moves to `@konjir/kolab` | Lee, 2026-11-18 |
| The command is `kolab`, with no `konjir` alias | Lee, 2026-11-18 |
| The existing `konjir` package on npm (latest 0.8.0) is left alone: not deprecated, no shim, no new versions. It is to be repurposed later | Lee, 2026-11-18 |
| One marketing site at `www.konjir.com`, with each package's page under it: `/kolab`, `/konnect`. `kolab.konjir.com` stays the Kolab app (web UI, `/mcp`, `/api`, `/oauth`, `/.well-known`) | Lee, 2026-11-18 |
| `www.konjir.com` is canonical, by the pages' canonical links, sitemap and Open Graph URLs. `konjir.com` serves the same pages and doesn't redirect for now: until step 2 the site answered www with an uncached 301 to the apex, which browsers may keep for good, so redirecting the apex back would loop for them. Redirecting it is a later, deliberate change, once those have aged out | Proposed by Claude, unless Lee says otherwise |
| Names machines read keep `konjir`: the `konjir_*` tool names, `kj:` addresses, `KONJIR_URL`, `KONJIR_TOKEN`, and the MCP entry keys `konjir connect` writes. Only what people install and type changes | Proposed by Claude, unless Lee says otherwise |
| No `konnect.konjir.com` for now (it doesn't resolve today, and nothing needs it) | Proposed by Claude, unless Lee says otherwise |
| Each landing page stays a claude.ai artboard published from `site/src/` (D92's mechanics). The existing [Konjir Marketing Page](https://claude.ai/artifact/7CLh2TuhVwCxrFSvyzGw1W) artifact becomes the Kolab page; the www and konnect pages get new artifacts | Proposed by Claude, unless Lee says otherwise |

Still needed from Lee: the text of a privacy policy and terms (the site asks people to sign in with GitHub and links to neither), and what to say about pricing and limits during early testing.

## Review of konjir.com as deployed, 2026-11-18

Checked with Playwright at 1440×900 and 390×844, in both themes, with `/hands-on/`, `/messages/`, a 404, the response headers, `www.konjir.com`, `kolab.konjir.com` and `konnect.konjir.com`.

What works and should stay: the typography (Fraunces, Instrument Sans, JetBrains Mono), the Daybreak and Predawn palettes, the plain voice, real product fragments instead of illustrations, the strict CSP, and the speed (DOMContentLoaded about 250 ms, everything static and hashed). Text contrast passed a WCAG AA check on every text block.

What to fix, most important first:

1. **It never says what Konjir is or how to get it.** "npm" appears nowhere on the page and there's no install line. That Kolab is an MCP server with a CLI comes out only in the fifth section, "Bring your own harness". For a page about a package, this is the biggest gap.
2. **The hero is spent on a photo.** "Name it true." is a brand line, not a reason to care; the real promise is the small eyebrow, "Specs and agents, kept in step". The STALE card is the hook, but it's a small static fragment in `kj:password-reset-pg@2#B9` syntax nobody can read yet.
3. **Jargon before definitions.** Kolab, binding, mark, settle, holds, circle, true name and `kj:checkout@3#R1` all appear before anything explains them.
4. **The best demo is static, and its buttons do nothing.** "A change lands exactly where it matters" is the core idea but sits in section 3, and "Still holds" and "Revise B9" are real `<button>`s with no effect. Its copy opens "Lee tightened a rate limit…", which reads as internal.
5. **The terminal block is a wall.** Twenty lines, three alternative routes and a "sign in as Yourself" caveat, in the older, longer commands that W9.1–W9.6 replaced.
6. **konnect is buried.** One line above the footer, though it's the simpler way in and a product of its own.
7. **Trust gaps.** No GitHub link, npm link, docs, licence, pricing or limits, about, privacy policy or terms.
8. **Two decorative blocks read as placeholders.** The striped band under the hero, and the flat-colour rectangle beside the final call to action, look like images that failed to load.
9. **About 250px of header on a phone.** No menu: the links wrap onto two rows, with the theme toggle and sign-up button stacked beneath.
10. **The article pages carry the home page's in-page links** (How it works, Roles, For agents, Kolabs), which jump readers off the article and back home. The hands-on page is about 6,000 words and 19,000px long.
11. **Sharing and search.** No Open Graph or Twitter tags or image (a shared link previews as bare text), no canonical link, `sitemap.xml` is a 404, and the title "Konjir: name it true" has no words saying what it is.
12. **Smaller:** the theme toggle's two buttons have no `aria-pressed`, so a screen reader can't tell which theme is on. A signed-out visitor to `kolab.konjir.com` sees a bare "Connecting to Kolab…".

## The new site

`www.konjir.com`, from `site/`, deployed by the existing `site` Terraform module:

| Path | Page | Source |
| --- | --- | --- |
| `/` | The org page: one line on Konjir (tools for teams of people and their agents), a card each for Kolab and konnect with its install line, and "which one do I need?" | new artboard, `site/src/www/` |
| `/kolab/` | Kolab's product page: today's home page, reworked (step 4) | today's `site/src/project/Main.dc.html`, moved to `site/src/kolab/` |
| `/kolab/how-it-works/` | A short page for someone who has never used Kolab: under 700 words and one diagram (the substance of the binding's W9.8) | Markdown |
| `/kolab/hands-on/` | The tutorial, moved from `/hands-on/`, then rewritten on the shorter commands (the substance of W9.7) | `site/src/kolab/hands-on.md` |
| `/kolab/troubleshooting/` | The tutorial's troubleshooting, split out by that rewrite | Markdown |
| `/konnect/` | konnect's product page: install, three commands, an agent woken by a message, the harnesses it supports | new artboard, `site/src/konnect/` |
| `/konnect/guide/` | Today's `/messages/` | `site/src/konnect/guide.md` |

Redirects, all 301 and cacheable for a day, in the site's CloudFront Function, on both hosts: `/hands-on/…` to `https://www.konjir.com/kolab/hands-on/…`; `/messages/…` to `https://www.konjir.com/konnect/guide/…`. `konjir.com` serves the same pages as `www.konjir.com` and doesn't redirect (see *Decisions*).

## Older konnect keeps working

Every published `@konjir/konnect` (0.1.0 to 0.8.0 on npm today) talks to the server at `kolab.konjir.com`, and some of it depends on more than the protocol. None of this plan may break those versions. Each step is either client-only or website-only, so it never reaches them, or it keeps the contract below unchanged.

**What can't affect them:**
- **Steps 2 to 5** change only the static site. It's a separate S3 bucket and CloudFront distribution, and `kolab.konjir.com` isn't touched. The only places older konnect points at the site are its README's link to `https://konjir.com` and the guide at `/messages/`. The 301s in step 2 cover both, and they stay for good.
- **Step 1's client half (1a)** changes what's built and published as `@konjir/kolab`, and nothing the server serves. `@konjir/konnect` keeps its name.

**The biggest constraint: `https://kolab.konjir.com/mcp` never moves.** Every published konnect hard-codes it as `HOSTED_URL`, and every published `konjir` CLI as its default (API25). Saved logins are keyed by that URL (`libs/login`), and OAuth checks the resource URL. So moving it, even behind a redirect, would break every installed copy and sign everyone out. The only fix would be each person setting `KONNECT_URL` by hand. This is why the product pages live at `www.konjir.com/kolab` and `/konnect` and kolab.konjir.com stays the app. No step of this plan changes that host or path, and no later change may.

**The contract the server keeps, whatever else changes** (old konnect depends on each part):

| What | Where older konnect depends on it |
| --- | --- |
| `https://kolab.konjir.com/mcp`, `/oauth/*` (including `/oauth/setup`) and `/.well-known/*`, at those paths | `HOSTED_URL` in `apps/konnect/src/teams.ts`; `libs/login`, which is bundled into konnect |
| Every `konjir_*` tool name, and the resource `konjir://answers/<kolab>/<actor>` | `apps/konnect/src/client.ts` |
| The OAuth scope grammar `konjir kolab:<team> setup:<label>:<role>` | `agentSetupScope` in `apps/konnect/src/agents.ts` |
| The credentials folder `$XDG_CONFIG_HOME/konjir/` (`~/.config/konjir/`) | `libs/login`, shared by both CLIs, so the rename must not move it |
| The exact wording of the server errors konnect rewrites or recognises: `run konjir connect again` and `konjir connect` (agents.ts:68), `is not a member of kolab` (cmd-messages.ts), `only the owner of kolab <k> can archive/erase it`, and other `only the owner of kolab` errors (cmd-team.ts), `kolab <name>` rewritten to `team <name>` (cmd-agent.ts, cmd-host.ts). The contract test (PR #179) showed that changing `is not a member of kolab` or `only the owner of kolab` breaks 0.1.0 and 0.8.0 | The server's texts in `apps/server/src/oauth/pages.ts` and `libs/engine/src/kolab.ts` |
| An ended or revoked session comes back as a 401, and a refresh as `invalid_grant` | client.ts:367 recognises an expired session from the 401 and the bundled libs/login's own "has ended or was revoked" message. The server's `missing, expired or invalid Konjir token` wording (auth.ts:60) travels only in the `WWW-Authenticate` header and no konnect reads it. PR #179 changed it and every version still passed |

**How:**
1. Split step 1 into **1a, client only**, which ships with no server deploy, and **1b, the server's texts**.
2. In 1b, change `konjir` to `kolab` only in texts that no released konnect matches: the job playbooks, review instructions, release hints and the web page's instructions. The phrases in the table stay word for word. To word them for `kolab` users anyway, the server can choose the wording by the client's name, but only by opting in: a client that says it is the new CLI gets the new text, and everything else gets today's. It can't be the other way round. Every published konnect (0.1.0 to 0.8.0) calls itself `konnect` with version `0.1.0`, and when it signs in, its bundled libs/login connects as `konjir-cli 0.6.0`, so a rule like "konnect keeps the old text" would miss those connections. For the opt-in to work, the renamed CLI, and the libs/login inside it, must send a name of its own (`kolab`). A server error that konnect has stopped matching can change only once no older konnect still in use matches it.
3. The server logs `clientInfo.name` and `clientInfo.version` once per connection (PR #179: at `initialize`, and at `server/discover`, which every published konnect uses instead). Published konnect versions all report `0.1.0`, so the log can tell only "some konnect up to 0.8.0" apart from 0.9.0 and later, which send their real version. "No older konnect still in use" therefore becomes readable once 0.9.0 has shipped: count the connections from `konnect 0.1.0`.
4. A contract test in CI: a job installs the oldest and the newest published `@konjir/konnect` from npm and runs them against the branch's server. It covers log in, `send`, `receive`, `team list`, an expired session (konnect must say to log in again), and a message to someone who isn't a member (konnect must say "isn't in team"). It runs on every pull request that touches `apps/server`, `libs/engine` or `libs/login`. It also guards konnect's own future releases.
5. Deploy 1b only with that test green.

**What 1b did** (`apps/server/src/wording.ts`):
- **Said `kolab` to everyone**, since no released client reads them by their words: the operating and reviewer instructions, the job playbooks, the tools' descriptions, the hints in results (`next`, the release hint after an approval, the import report's sign-in steps), the web page's instructions and onboarding command lines, and the web API's refusal of an agent's session.
- **Kept `konjir <command>` for every client but kolab** in Kolab's errors and its sign-in and setup pages, and in what those tell the app (`error_description`, `/oauth/setup`'s errors). Published konnect reads `run konjir connect again` and `konjir connect` in a setup's errors, `kolab <name>` in some refusals (rewritten to `team <name>`, so a `kolab login` there would read `team login`), and `run konjir login`; published konjir reads `run konjir login`. Rather than trace which error can reach which of those paths, every error keeps the old command names unless the client opts in. The engine still writes those errors with `konjir` (the release hint too, where an approved package's refusal quotes it), and the server words them for the client at the boundary: `fail()` for a tool's error, and the OAuth controller and pages. The words for a command are one list, which the server and kolab's own rewording share (a test holds them equal).
- **The opt-in.** Over MCP, a request whose `clientInfo.name` is exactly `kolab`: a 2026-07-28 client sends it in `_meta` on every request, so each call is worded for it (`McpWording`, an AsyncLocalStorage around the request). A 2025-era client sends it only at `initialize`, and `/mcp` is stateless, so its calls get the old words; kolab and its channel speak 2026-07-28. Requests answered at once, interleaved, are each worded for their own client (a test pins it, and fails with the wording kept anywhere shared). Over OAuth there is no MCP client, so the pages and endpoints key on the name the client registered with: `kolab` or `kolab …`. kolab now registers as `kolab CLI`, `kolab connect` and `kolab channel (Claude Code)`, and its `@konjir/login` sign-in connects as `kolab` (a `clientInfo` option, `konjir-cli 0.6.0` by default, so konnect's is unchanged). A sign-in kept from before keeps its old registration, `konjir CLI`, and with it the old words on a page until it signs in afresh.
- **Unchanged for everyone:** `konjir_*` tool names, `kj:` and `konjir://` addresses, the scope grammar, and phrasing about kolabs (`only the owner of kolab …`, `is not a member of kolab …`, `you own kolab …`).
- **Jobs.** The playbooks and hints say `kolab work deliver`, so `kolab work` no longer writes a `konjir` beside a job's `kolab`, nor allows `Bash(konjir *)`. A job's own MCP client is its harness (Claude Code), which doesn't opt in, so an error it meets still says `konjir <command>`; each such error names a person's step (`konjir repo register`, `konjir login`), never one a job runs. Evidence of a release, which a job never records, is refused naming only the tool, `konjir_record_release`, which every client has.
- **Accepted:** a job started by a konjir@0.8.0 runner is told `kolab work deliver`, a command its job doesn't have (that runner puts only `konjir` on the job's `PATH`); and anyone still on konjir@0.8.0 reads `kolab` in instructions, descriptions and hints.

## Steps

In order. Step 2 ships before any content changes, so every later step only changes content. Step 1 is split as above: 1a (client) first, then 1b (the server's texts), with the contract test landed before 1b.

### 1. Rename the package to @konjir/kolab, with the command `kolab`

- `apps/cli/package.json`: name `@konjir/kolab`, bin `kolab`. Versions continue after 0.8.0, so the first is 0.9.0.
- `bin/konjir` becomes `bin/kolab`; root `package.json`'s `konjir` and `serve` scripts follow.
- `apps/cli/scripts/package.mjs` and `bundle.mjs`: the bundle and binaries become `kolab.mjs` and `kolab-<platform>`; the help, errors and `--version` say `kolab`.
- Every text that tells a person or an agent to run `konjir …` says `kolab …`, except the server's phrases that older konnect matches, which stay as they are (*Older konnect keeps working*). Texts in `apps/cli` and the docs are 1a; texts in `apps/server` and `libs/engine` are 1b. About 80 files hold such text, across `apps/cli` (about 30), `libs/engine` (playbooks and review instructions), `apps/server` (release hints and errors), `apps/web`, `apps/konnect`, `apps/channel-bridge`, `libs/db`, `libs/login`, `.github/workflows`, `docs/verbs.md` (regenerate with `npm run verbs`), `README.md`, `deploy/demo/DEMO.md`, and `site/src/hands-on.md`. Find them with `git grep -P '\bkonjir (work|login|connect|serve|resolve|repo|stale|queries|claude|bridge|import|files|watch|disconnect)\b'`. `CLAUDE.md` is Lee's to change: list what's out of date in the pull request.
- The web page's `npx` line: `KONJIR_CLI_NPM_SPEC` in `deploy/terraform/main.tf` becomes `@konjir/kolab@<version>`, and the page shows `npx @konjir/kolab@<version>`.
- `konjir connect` (now `kolab connect`) writes MCP entries that run `npx -y @konjir/kolab@<version> bridge`. Entries already written by konjir@0.8.0 keep working, since that package stays on npm.
- The Claude Code plugin manifests (`.claude-plugin/marketplace.json`, `apps/channel-bridge/.claude-plugin/plugin.json`, `apps/channel-bridge/.mcp.json`) name `@konjir/kolab`.
- `.github/workflows/release-cli.yml`, `cli.yml` and `apps/cli/scripts/smoke.sh` publish and smoke-test `@konjir/kolab` and `kolab`.
- The login store path stays where it is, so existing sign-ins carry over.
- `README.npm.md` and the package's `homepage` point at `https://www.konjir.com/kolab/`; `@konjir/konnect`'s at `https://www.konjir.com/konnect/`.
- **Lee's step:** npm trusted publishing for `@konjir/kolab`. Change `tools/npm-trust.sh` to the new name and run it after `npm login`, as was done for `konjir` and `@konjir/konnect`.
- **1b, done:** the server's texts say `kolab` as *What 1b did* (above) says: outright where no released client reads them, and in errors and sign-in pages only for a client that says it is kolab. The web page's `npx` line shows what `KONJIR_CLI_NPM_SPEC` names, `@konjir/kolab@0.9.0` since the first release.
- **Known consequence of leaving `konjir` alone:** once the server's texts say `kolab`, anyone still on konjir@0.8.0 is told to run a command they don't have, in instructions, descriptions and hints (its errors keep `konjir`). The release notes and the site's install lines say to install `@konjir/kolab`.

### 2. Split the site, with no change to content

- `deploy/site/build.mjs` builds several landing pages, each an artboard in `site/src/<section>/`, and the articles under them. `site/src/project/Main.dc.html` and its images move to `site/src/kolab/`; `hands-on.md` moves to `site/src/kolab/`, `messages.md` to `site/src/konnect/guide.md`. Until step 3 lands, `/` is a minimal org page linking to `/kolab/` and `/konnect/`.
- One shared header for every page: the Konjir mark, a product switcher (Kolab, konnect), and the section's own links. An article's links stay within its section instead of jumping to the home page's anchors.
- `deploy/terraform/modules/site`: `www.konjir.com` canonical by canonical links, `konjir.com` serving the same pages without redirecting until the old cached www-to-apex redirects have aged out, and the old paths' 301s to www's new paths above. The certificate already covers both names.
- The build writes `sitemap.xml`, a canonical link, Open Graph and Twitter tags on every page, and an Open Graph image per landing page (static PNGs in `site/src/<section>/`).
- `site/README.md` describes the new layout and how each artboard is published to its artifact.
- Check: every old URL redirects to its new one, every page renders in both themes at 390px and 1440px, and the console shows no errors.

### 3. The org page, `/`

- What Konjir is, in one sentence, and who it's for.
- A card each for Kolab and konnect: what it is in a line, its install line (`npm i -g @konjir/kolab`, `npm i -g @konjir/konnect`), and a link to its page.
- "Which one do I need?": konnect to get a team of people and agents talking today; Kolab to keep specs and the code built from them in step.
- Footer from step 6.

### 4. Rework the Kolab page, `/kolab/`

- Lead with what it is (an MCP server and a CLI that keep a spec and the code built from it in step) and the install line, above the fold.
- Replace the hero photo with the stale-mark moment, made to work: a requirement changes, exactly one binding element is marked, and "Still holds" or "Revise" settles it. It runs in `deploy/site/site.js`, which the CSP already allows.
- Introduce each term (kolab, spec, binding, mark, address) in plain words before the page uses it.
- One route in the terminal, three or four commands on the shorter command set, with the alternatives behind a link to the tutorial.
- Replace "Lee" in the example with a persona.
- Drop the striped band and the flat-colour block, or replace them with product fragments.
- Then the tutorial rewrite and the how-it-works page under `/kolab/` (the substance of W9.7 and W9.8 in the binding).

### 5. The konnect page, `/konnect/`

- What it is in a line, the install line, and the three commands that get a team talking (from `apps/konnect/README.npm.md`).
- One worked moment: a message to `@sam/reviewer` wakes the agent and its answer comes back.
- What you need (Node 22, GitHub; tmux or screen only for background agents) and the harnesses it supports (Claude Code, Codex, OpenCode).
- Links to `/konnect/guide/` and the man page.

### 6. Trust and polish, on every page

- Footer: GitHub (`konjir/kolab`), npm (`@konjir/kolab`, `@konjir/konnect`), licences (FSL-1.1-ALv2 for the server, Apache-2.0 for the CLIs), privacy, terms, contact.
- Privacy policy and terms, once Lee supplies their text.
- A menu on narrow screens, so the header is one row on a phone.
- `aria-pressed` on the theme toggle's buttons.
- **Done:** every footer links to GitHub, both packages on npm and the licences (the server's `LICENSE.md`, FSL-1.1-ALv2; `apps/cli/LICENSE` and `apps/konnect/LICENSE`, Apache-2.0). Privacy and terms wait for Lee's text, and the repository names no contact, so neither is linked. The header is one row at any width, 77px at 390px where it was up to 201px: below 1200px the section's links, the theme switch and the sign-in are in a `<details>` menu, which works with no script. The theme switch is a radio group whose radios' `aria-checked` site.js keeps in step on every page, which says what `aria-pressed` would have; a radio can't also take `aria-pressed`.
- Signed-out visitors to `kolab.konjir.com` see a sign-in page with a link to `www.konjir.com/kolab/`, not a bare "Connecting to Kolab…". This changes only the web page's own signed-out view. The `/oauth/*` pages that konnect's login and agent setup open stay exactly as they are.
