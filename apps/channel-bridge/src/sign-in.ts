/**
 * How the bridge signs in to Kolab (W3.5, D55): with KONJIR_TOKEN when it is set (a hand-issued
 * session token, which overrides any sign-in), or else with the sign-in `konjir login` keeps for
 * the same MCP URL, in the same credentials file, shared with the konjir CLI (@konjir/login). With
 * no sign-in kept, the bridge signs in by itself on first start, as `konjir login` does: it opens
 * the person's browser at Kolab's sign-in and tells the session so, with the link. That sign-in is
 * kept for the CLI too. KONJIR_CHANNEL_SIGN_IN=off turns that off, and the bridge then waits for
 * `konjir login`.
 */
import { StoredLogin, login, openBrowser } from '@konjir/login';
import type { ChannelMessage } from './messages.js';

/** What the bridge reaches Kolab with: exactly one of a token and a sign-in. */
export type BridgeAuth = { token: string; login?: undefined } | { token?: undefined; login: StoredLogin };

/** The name the bridge registers under, which Kolab's consent page shows. */
export const CLIENT_NAME = 'konjir channel (Claude Code)';

/** KONJIR_CHANNEL_SIGN_IN: on (the default) or off. */
export function signInOn(env: NodeJS.ProcessEnv): boolean {
  const v = (env.KONJIR_CHANNEL_SIGN_IN ?? '').trim().toLowerCase();
  if (v === '' || ['on', '1', 'true', 'yes'].includes(v)) return true;
  if (['off', '0', 'false', 'no'].includes(v)) return false;
  throw new Error('KONJIR_CHANNEL_SIGN_IN is on or off');
}

/**
 * The bridge's credential for `url`. With no KONJIR_TOKEN and no sign-in kept, and sign-in on, it
 * runs the browser sign-in first and resolves once that is done, or has failed (then the bridge
 * waits for `konjir login`). `open` sends the person's browser (tests stand one in).
 */
export async function bridgeAuth(url: string, env: NodeJS.ProcessEnv, io: {
  forward(m: ChannelMessage): Promise<void>;
  log(line: string): void;
  open?: (u: URL) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<BridgeAuth> {
  // An empty KONJIR_TOKEN is unset: the plugin's .mcp.json passes ${KONJIR_TOKEN:-}.
  if (env.KONJIR_TOKEN) return { token: env.KONJIR_TOKEN };
  const stored = new StoredLogin(url, { clientName: CLIENT_NAME });
  if (stored.signedIn) {
    io.log(`using the sign-in konjir login keeps for ${url}`);
    return { login: stored };
  }
  if (!signInOn(env)) {
    io.log(`no sign-in is kept for ${url}, and KONJIR_CHANNEL_SIGN_IN is off: run konjir login --url ${url}`);
    return { login: stored };
  }
  try {
    const me = await login(url, {
      clientName: CLIENT_NAME,
      timeoutMs: io.timeoutMs,
      log: (line) => io.log(line),
      open: async (u) => {
        // The link carries no secret: Kolab's code comes back only to this process's loopback port, with this sign-in's state.
        void io.forward({
          content: `The Konjir channel needs a sign-in to Kolab at ${url}, so it opened the user's browser at Kolab's sign-in page. Tell the user: sign in there with GitHub, and on Kolab's page choose the agent this session works as, its kolab and its role. If no browser opened, the user can open this link themself: ${u.toString()}\nOr run konjir login --url ${url} in a terminal. Inbox changes start arriving once that is done.`,
          meta: { kind: 'bridge', status: 'signing_in' },
        }).catch(() => undefined);
        await (io.open ?? openBrowser)(u);
      },
    });
    io.log(`signed in to ${url} as ${me.actor}, in kolab ${me.kolab} as ${me.role}; kept for konjir too`);
  } catch (e) {
    const why = String((e as Error).message ?? e).replace(/\bkj[src]_[A-Za-z0-9_-]+/g, '***');
    io.log(`the sign-in didn't finish (${why}); waiting for konjir login --url ${url}`);
  }
  return { login: new StoredLogin(url, { clientName: CLIENT_NAME }) };
}
