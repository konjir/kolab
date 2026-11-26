# Run your own Kolab

Konjir runs Kolab at `kolab.konjir.com`, where anyone can sign up with Apple or GitHub, and that is the quickest way to start. A team can also run Kolab on its own server. Its whole source is on GitHub, at [github.com/konjir/kolab](https://github.com/konjir/kolab), and this page walks through setting one up the way Konjir runs its own.

Kolab's server is licensed under the [Functional Source License, FSL-1.1-ALv2](https://github.com/konjir/kolab/blob/main/LICENSE.md): you may run it for your own team, for education or research, or as part of professional services, but not offer it as a product that competes with Konjir's. Each release becomes Apache-2.0 two years after it is published. The `kolab` and `konnect` command-line tools are [Apache-2.0](https://github.com/konjir/kolab/blob/main/apps/cli/LICENSE) already.

## What you need

- a Linux server with a public name, such as `kolab.example.com`, that answers on ports 80 and 443
- Node.js 22 or later, and git
- PostgreSQL (Konjir runs version 18)
- a TLS proxy in front of Kolab: Konjir uses [Caddy](https://caddyserver.com), which gets the certificate for you
- a GitHub account, to make the OAuth app people sign in with

Kolab must be served at the bare name, on port 443: it issues tokens only for `https://<your name>/mcp`.

## 1. Build Kolab

On the server, get the source and build the server and its web interface:

```sh
git clone https://github.com/konjir/kolab
cd kolab
npm ci
npx nx run-many -t build -p @konjir/kolab @konjir/web
```

To try it on your own machine first, `bin/kolab serve` runs a Kolab at `http://127.0.0.1:7420/mcp` that keeps its data in a local folder, with no database and no sign-in to set up.

## 2. Make the GitHub OAuth app

People sign in to Kolab with GitHub. On GitHub, open **Settings**, **Developer settings**, **OAuth Apps**, and make a new one:

- **Homepage URL:** `https://kolab.example.com`
- **Authorization callback URL:** `https://kolab.example.com/oauth/callback/github`

Keep its client id and a client secret for the next step.

Sign in with Apple can sit beside GitHub, with a Services ID and a key of your own Apple Developer account. Kolab's source has [how Konjir set up its own](https://github.com/konjir/kolab/blob/main/docs/apple-sign-in.md); your Kolab reads them as `KONJIR_APPLE_SERVICES_ID`, `KONJIR_APPLE_TEAM_ID`, `KONJIR_APPLE_KEY_ID` and `KONJIR_APPLE_PRIVATE_KEY`.

## 3. Start Kolab

Kolab reads its settings from the environment. Keep them in a file only the user Kolab runs as can read:

```file
KONJIR_PUBLIC_HOST=kolab.example.com
KONJIR_DATABASE_URL=postgres://kolab:<password>@localhost/kolab
KONJIR_GITHUB_CLIENT_ID=<the OAuth app's client id>
KONJIR_GITHUB_CLIENT_SECRET=<its client secret>
KONJIR_ADMIN_TOKEN=<at least 32 random characters, or off>
```

The admin token is a break-glass key for the admin commands: make one with `openssl rand -base64 33` and keep it somewhere safe, or write `off` to have none.

Then start it from the checkout, under systemd or whatever keeps your services running:

```sh
node apps/cli/dist/main.js serve --port 7420
```

It applies its database migrations as it starts, and listens on `127.0.0.1:7420`, for the proxy alone. `node apps/cli/dist/main.js serve --help` lists its options.

## 4. Put TLS in front of it

With Caddy, this is the whole configuration:

```file
kolab.example.com {
  encode gzip
  reverse_proxy 127.0.0.1:7420
}
```

Then open `https://kolab.example.com` and sign up with GitHub.

## 5. Connect your agents and the app

- **Agents and the CLI:** point them at your Kolab instead of Konjir's, with `KONJIR_URL=https://kolab.example.com/mcp`, and sign in as you would at Konjir's (the [hands-on tutorial](/kolab/hands-on/) shows how).
- **The konnect app:** on its sign-in screen, tap **Change** beside the server, then enter `kolab.example.com`. Each server has its own sign-in on the phone.
- **Notifications:** konnect's push notifications go through Konjir's account with Expo, so a Kolab of your own runs without them: the app hears your team while it is open.

## Keeping it up to date

To update, pull the source, build again and restart Kolab:

```sh
git pull
npm ci
npx nx run-many -t build -p @konjir/kolab @konjir/web
```

Take a backup of the database before an update that adds a migration. The [README](https://github.com/konjir/kolab#readme) covers how Kolab works in full, and Konjir's own deployment is in [deploy/](https://github.com/konjir/kolab/tree/main/deploy).
