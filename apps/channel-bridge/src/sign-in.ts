/**
 * How the bridge signs in to Kolab (W3.5, D55): with KONJIR_TOKEN when it is set (a hand-issued
 * session token, which overrides any sign-in), or else with the sign-in `konjir login` keeps for
 * the same MCP URL, in the same credentials file, shared with the konjir CLI (@konjir/login). With
 * no sign-in kept, the bridge signs in by itself on first start, as `konjir login` does: it opens
 * the person's browser at Kolab's own sign-in page and tells the session so in fixed words, with
 * the link only in its log. That sign-in is kept for the CLI too. KONJIR_CHANNEL_SIGN_IN=off turns
 * that off, and so does a machine with no browser to open (CI, an SSH session, no display): the
 * bridge then waits for `konjir login`.
 *
 * One bridge signs in at a time: a marker lock beside the credentials file (`.signing-in`), under
 * which the bridge checks again, under the credentials lock, that nothing was kept meanwhile. A
 * sign-in that finishes after a `konjir login` kept one yields: the other is kept, and the
 * bridge's own grant is revoked.
 */
import { FileLock, StoredLogin, checkKolabUrl, login, openBrowser, safeUrl } from '@konjir/login';
import { randomBytes } from 'node:crypto';
import type { ChannelMessage } from './messages.js';

/** What the bridge reaches Kolab with: exactly one of a token and a sign-in. */
export type BridgeAuth = { token: string; login?: undefined; awaiting?: undefined }
  | { token?: undefined; login: StoredLogin; awaiting?: 'another-channel' };

/** The name the bridge registers under, which Kolab's consent page shows. */
export const CLIENT_NAME = 'konjir channel (Claude Code)';

/** How long the bridge's own sign-in waits for the person, by default. */
const SIGN_IN_MS = 5 * 60_000;

/** Anything shaped like a Kolab secret, masked. */
export const mask = (text: string) => text.replace(/\bkj[src]_[A-Za-z0-9_-]+/g, '***');

/** KONJIR_CHANNEL_SIGN_IN: on (the default) or off. */
export function signInOn(env: NodeJS.ProcessEnv): boolean {
  const v = (env.KONJIR_CHANNEL_SIGN_IN ?? '').trim().toLowerCase();
  if (v === '' || ['on', '1', 'true', 'yes'].includes(v)) return true;
  if (['off', '0', 'false', 'no'].includes(v)) return false;
  throw new Error('KONJIR_CHANNEL_SIGN_IN is on or off');
}

/**
 * Whether a browser can be opened for the person here: not in CI, not over SSH, and on Linux and
 * the BSDs only with a display. The bridge never has a terminal of its own (Claude Code holds its
 * stdio), so this is what tells an attended desktop from a headless run.
 */
export function browserAvailable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  if (env.CI || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * The bridge's credential for `url`. With no KONJIR_TOKEN and no sign-in kept, and a sign-in of
 * its own allowed, it runs the browser sign-in first and resolves once that is done, or has
 * failed (then the bridge waits for `konjir login`). `open` sends the person's browser (tests
 * stand one in); with it given, a browser is taken to be there.
 */
export async function bridgeAuth(url: string, env: NodeJS.ProcessEnv, io: {
  forward(m: ChannelMessage): Promise<void>;
  log(line: string): void;
  open?: (u: URL) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<BridgeAuth> {
  // An empty KONJIR_TOKEN is unset: the plugin's .mcp.json passes ${KONJIR_TOKEN:-}.
  if (env.KONJIR_TOKEN) return { token: env.KONJIR_TOKEN };
  checkKolabUrl(url);
  const shown = safeUrl(url);
  const stored = new StoredLogin(url, { clientName: CLIENT_NAME });
  if (stored.signedIn) {
    io.log(`using the sign-in konjir login keeps for ${shown}`);
    return { login: stored };
  }
  const run = `run konjir login --url ${shown} in a terminal`;
  if (!signInOn(env)) {
    io.log(`no sign-in is kept for ${shown}, and KONJIR_CHANNEL_SIGN_IN is off: ${run}`);
    return { login: stored };
  }
  if (!io.open && !browserAvailable(env)) {
    io.log(`no sign-in is kept for ${shown}, and no browser can be opened here (CI, SSH or no display): ${run}`);
    return { login: stored };
  }

  // One bridge at a time: another holding the marker is signing in, and this one picks its sign-in up.
  const timeoutMs = io.timeoutMs ?? SIGN_IN_MS;
  const marker = new FileLock(`${stored.file}.signing-in`, 0, timeoutMs + 60_000);
  const me = `b${process.pid}_${randomBytes(12).toString('hex')}`;
  try {
    await marker.acquire(me);
  } catch (e) {
    const why = mask(String((e as Error).message ?? e));
    if (/another konjir holds it/.test(why)) {
      io.log(`another konjir channel started a browser sign-in to ${shown}; this one will use that sign-in once it is done`);
      return { login: stored, awaiting: 'another-channel' };
    }
    // A marker that is a symbolic link, or one konjir can't read or remove: said as it is.
    io.log(`the channel can't sign in by itself (${why}); ${run}`);
    return { login: stored };
  }
  try {
    // Under the credentials lock: a sign-in kept since the first look is used, and nothing is registered.
    // What it saw there is the sign-in's baseline: none (''), so any kept after this makes it yield.
    if (await stored.locked(async () => stored.signedIn)) {
      io.log(`using the sign-in another konjir kept for ${shown} meanwhile`);
      return { login: stored };
    }
    const who = await login(url, {
      clientName: CLIENT_NAME,
      timeoutMs,
      yieldTo: '',
      log: (line) => io.log(mask(line)),
      open: async (u) => {
        // Fixed words only: the link, which login() has checked is Kolab's own sign-in page, stays in the log.
        void io.forward({
          content: `Konjir needs the user to sign in to Kolab at ${shown}: a browser window opened at Kolab's sign-in page. If it didn't, the link is in the Konjir channel's log, or the user can ${run}. Inbox changes start arriving once that is done. Tell the user.`,
          meta: { kind: 'bridge', status: 'signing_in' },
        }).catch(() => undefined);
        if (io.open) await io.open(u);
        else openBrowser(u, url);
      },
    });
    io.log(who.yielded
      ? `another konjir signed in to ${shown} meanwhile, as ${who.actor}: the channel uses that sign-in, and revoked its own`
      : `signed in to ${shown} as ${who.actor}, in kolab ${who.kolab} as ${who.role}; kept for konjir too`);
  } catch (e) {
    io.log(`the sign-in didn't finish (${mask(String((e as Error).message ?? e))}); waiting for konjir login --url ${shown}`);
  } finally {
    marker.release(me);
  }
  return { login: new StoredLogin(url, { clientName: CLIENT_NAME }) };
}
