/**
 * Who a person is, according to an identity provider (D55). Kolab signs people up and in with an
 * identity provider, GitHub first; others can be added later behind this interface. A provider
 * only says who signed in. Kolab keeps nothing of theirs but the provider's stable id for the
 * person and their login: no provider token is stored, and none is passed on (DEL4).
 */
export interface IdentityProvider {
  /** Its name in the identity table and in Kolab's callback URL, /oauth/callback/<id>: lowercase. */
  readonly id: string;
  /** What the sign-in button says: "Sign in with <label>". */
  readonly label: string;
  /**
   * Where to send the browser to sign in. Kolab is the provider's OAuth client: `redirectUri` is
   * Kolab's callback, `state` binds the answer to this sign-in (CSRF), and `codeChallenge` is the
   * S256 PKCE challenge of the verifier `identify` will be given.
   */
  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string;
  /**
   * Who signed in, from the code the provider sent to Kolab's callback. `subject` is the
   * provider's own id for the person, which never changes hands (GitHub's numeric user id);
   * `login` what they are called there now. Throws if the code is no good.
   */
  identify(p: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ subject: string; login: string; name?: string }>;
}

type Fetch = typeof fetch;

/**
 * GitHub, through a GitHub OAuth app (D55). It asks for no scope, so Kolab sees only the public
 * profile: the user's id, login and name. The client id and secret come from configuration
 * (`KONJIR_GITHUB_CLIENT_ID`, `KONJIR_GITHUB_CLIENT_SECRET`), on the test server from SSM. The
 * GitHub token a sign-in yields is used once, to read who signed in, then revoked.
 */
export class GitHubIdentity implements IdentityProvider {
  readonly id = 'github';
  readonly label = 'GitHub';

  constructor(private readonly config: {
    clientId: string; clientSecret: string;
    /** For tests: GitHub's web and API origins, and the fetch to reach them with. */
    webOrigin?: string; apiOrigin?: string; fetch?: Fetch; timeoutMs?: number;
  }) {
    if (!config.clientId || !config.clientSecret) throw new Error('GitHub sign-in needs the OAuth app\'s client id and secret');
  }

  private get web() { return this.config.webOrigin ?? 'https://github.com'; }
  private get api() { return this.config.apiOrigin ?? 'https://api.github.com'; }
  private get fetch(): Fetch { return this.config.fetch ?? fetch; }
  private signal() { return AbortSignal.timeout(this.config.timeoutMs ?? 10_000); }

  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string {
    const u = new URL('/login/oauth/authorize', this.web);
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('allow_signup', 'true');
    return u.toString();
  }

  async identify(p: { code: string; redirectUri: string; codeVerifier: string }) {
    const res = await this.fetch(new URL('/login/oauth/access_token', this.web), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId, client_secret: this.config.clientSecret,
        code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier,
      }),
      signal: this.signal(),
    });
    const t = await res.json().catch(() => ({})) as { access_token?: unknown; error?: unknown };
    // Never the response itself in the error: it may carry a token.
    if (!res.ok || typeof t.access_token !== 'string') throw new Error(`GitHub didn't accept the sign-in (${typeof t.error === 'string' ? t.error.slice(0, 80) : res.status})`);
    const token = t.access_token;
    try {
      const u = await this.fetch(new URL('/user', this.api), {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'konjir-kolab', 'x-github-api-version': '2022-11-28' },
        signal: this.signal(),
      });
      const me = await u.json().catch(() => ({})) as { id?: unknown; login?: unknown; name?: unknown };
      if (!u.ok || typeof me.id !== 'number' || typeof me.login !== 'string') throw new Error(`GitHub didn't say who signed in (${u.status})`);
      return { subject: String(me.id), login: me.login, name: typeof me.name === 'string' && me.name ? me.name : undefined };
    } finally {
      // Kolab needs it no longer: revoke it, best effort.
      void this.fetch(new URL(`/applications/${encodeURIComponent(this.config.clientId)}/token`, this.api), {
        method: 'DELETE',
        headers: {
          accept: 'application/vnd.github+json', 'user-agent': 'konjir-kolab', 'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
        },
        body: JSON.stringify({ access_token: token }),
        signal: this.signal(),
      }).catch(() => undefined);
    }
  }
}

/**
 * An identity provider for tests and local development, which signs in whoever the test says,
 * with no browser and no network: `authorizationUrl` sends the browser straight back to Kolab's
 * callback with a code for the next person queued by `next` (or `as`). Only code can configure
 * it (startServer's `identity`); `konjir serve` never does.
 */
export class StubIdentity implements IdentityProvider {
  readonly id = 'stub';
  readonly label = 'Stub';
  private readonly queue: { subject: string; login: string; name?: string }[] = [];
  private readonly codes = new Map<string, { who: { subject: string; login: string; name?: string }; redirectUri: string; challenge: string }>();
  private n = 0;
  /** Who signs in when nobody is queued; undefined to refuse. */
  as?: { subject: string; login: string; name?: string };

  /** The next sign-in is this person. */
  next(who: { subject: string; login: string; name?: string }) { this.queue.push(who); return this; }

  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string {
    const who = this.queue.shift() ?? this.as;
    const u = new URL(p.redirectUri);
    u.searchParams.set('state', p.state);
    if (!who) { u.searchParams.set('error', 'access_denied'); return u.toString(); }
    const code = `stub-${++this.n}`;
    this.codes.set(code, { who, redirectUri: p.redirectUri, challenge: p.codeChallenge });
    u.searchParams.set('code', code);
    return u.toString();
  }

  async identify(p: { code: string; redirectUri: string; codeVerifier: string }) {
    const c = this.codes.get(p.code);
    this.codes.delete(p.code);
    const { createHash } = await import('node:crypto');
    if (!c || c.redirectUri !== p.redirectUri || createHash('sha256').update(p.codeVerifier).digest('base64url') !== c.challenge) {
      throw new Error('the stub provider didn\'t issue that code');
    }
    return c.who;
  }
}
