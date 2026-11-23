import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * Who a person is, according to an identity provider (D55). Kolab signs people up and in with an
 * identity provider: GitHub, and Sign in with Apple (Lee, 2026-11-23), behind this interface. A
 * provider only says who signed in. Kolab keeps nothing of theirs but the provider's stable id for
 * the person and their login: no provider token is stored, and none is passed on (DEL4); Apple's
 * are revoked as soon as the sign-in has read who signed in (AppleIdentity).
 */
export interface IdentityProvider {
  /** Its name in the identity table and in Kolab's callback URL, /oauth/callback/<id>: lowercase. */
  readonly id: string;
  /** What the sign-in button says: "Sign in with <label>". */
  readonly label: string;
  /**
   * Where to send the browser to sign in. Kolab is the provider's OAuth client: `redirectUri` is
   * Kolab's callback, `state` binds the answer to this sign-in (CSRF), and `codeChallenge` is the
   * S256 PKCE challenge of the verifier `identify` will be given. A provider without PKCE binds its
   * answer to the challenge another way: Apple's id_token carries it back as its `nonce`.
   * `prompt: 'select_account'` asks the provider to let the person choose which of their accounts
   * signs in, rather than going on with the one their browser is signed in to there; one that has
   * no such prompt ignores it.
   */
  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string; prompt?: 'select_account' }): string;
  /**
   * The origin `authorizationUrl` sends the browser to, when it is not Kolab's own: a form whose
   * answer is a redirect there must name it in the page's form-action (CSP3). Undefined for a
   * provider that answers on Kolab's own origin, as the stub does.
   */
  readonly authorizationOrigin?: string;
  /**
   * Who signed in, from the code the provider sent to Kolab's callback. `subject` is the
   * provider's own id for the person, which never changes hands (GitHub's numeric user id, Apple's
   * `sub`); `login` what they are called there now. A provider that has no usernames (Apple) gives
   * no `login`: the first time such an account signs in, Kolab's page asks the person to choose
   * their username (Kolab.chooseUsername). Throws if the code is no good.
   */
  identify(p: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ subject: string; login?: string; name?: string }>;
  /**
   * The account a username names now, for an invitation by account (migration 0053): its permanent
   * `subject`, as `identify` gives it, the login as the provider spells it, and whether it is a
   * person's account (not an organization's). Undefined when no account has that name. Throws when
   * the provider can't be asked. A provider without it takes no invitations by account: Apple's.
   * GitHub's also keeps its usernames for their owners: a username chosen at a first Sign in with
   * Apple is refused if it names an account here, or if this can't say (Kolab.chooseUsername).
   */
  lookup?(login: string): Promise<{ subject: string; login: string; person: boolean } | undefined>;
}

type Fetch = typeof fetch;

/**
 * GitHub, through a GitHub OAuth app (D55). It requests no scope, so the token reads public data
 * only, as long as the app only ever requests no scope; Kolab reads the user's id, login and name.
 * The client id and secret come from configuration (`KONJIR_GITHUB_CLIENT_ID`,
 * `KONJIR_GITHUB_CLIENT_SECRET`), in production from SSM. The GitHub token a sign-in yields is
 * used once, to read who signed in, then dropped. It is not revoked, so GitHub remembers the
 * authorization and doesn't ask again at the next sign-in.
 *
 * This OAuth app must stay dedicated to signing in to Kolab, with no scope. GitHub gives a request
 * without `scope` the scopes the person already granted the app, so if anything ever used it to
 * request a scope, Kolab's sign-ins would silently mint tokens with that scope.
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

  get authorizationOrigin() { return new URL(this.web).origin; }

  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string; prompt?: 'select_account' }): string {
    const u = new URL('/login/oauth/authorize', this.web);
    u.searchParams.set('client_id', this.config.clientId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('state', p.state);
    u.searchParams.set('code_challenge', p.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('allow_signup', 'true');
    // GitHub shows its account picker for it, so a person signed in there as one account can choose another.
    if (p.prompt) u.searchParams.set('prompt', p.prompt);
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
    const u = await this.fetch(new URL('/user', this.api), {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'konjir-kolab', 'x-github-api-version': '2022-11-28' },
      signal: this.signal(),
    });
    const me = await u.json().catch(() => ({})) as { id?: unknown; login?: unknown; name?: unknown };
    if (!u.ok || typeof me.id !== 'number' || typeof me.login !== 'string') throw new Error(`GitHub didn't say who signed in (${u.status})`);
    // The token is dropped here, never stored, logged or passed on (DEL4), and never revoked: GitHub
    // keeps an OAuth app's authorization only while the person holds a token of it, so revoking the
    // only one removes the authorization, and GitHub asks them to authorize Kolab again at every
    // sign-in. With no scope requested, it reads public data only, as long as the app only ever
    // requests no scope. An OAuth app's tokens don't expire on a timer: GitHub keeps at most 10 per
    // user and app, revoking the oldest past that, and drops one unused for a year.
    return { subject: String(me.id), login: me.login, name: typeof me.name === 'string' && me.name ? me.name : undefined };
  }

  /**
   * The account a GitHub username names (GET /users/<login>), public data only: its numeric id,
   * which never changes hands, the login as GitHub spells it, and whether it is a user's (not an
   * organization's). Asked as the OAuth app itself, with its client id and secret (HTTP basic), for
   * the app's rate limit rather than the anonymous one; no person's token is used. Undefined on 404.
   */
  async lookup(login: string) {
    // A username GitHub allows, and nothing else, goes in the path.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login)) return undefined;
    const res = await this.fetch(new URL(`/users/${encodeURIComponent(login)}`, this.api), {
      headers: {
        accept: 'application/vnd.github+json', 'user-agent': 'konjir-kolab', 'x-github-api-version': '2022-11-28',
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
      },
      signal: this.signal(),
    });
    if (res.status === 404) { await res.body?.cancel(); return undefined; }
    const u = await res.json().catch(() => ({})) as { id?: unknown; login?: unknown; type?: unknown };
    if (!res.ok || typeof u.id !== 'number' || typeof u.login !== 'string') throw new Error(`GitHub didn't say who ${login} is (${res.status}); try again in a while`);
    return { subject: String(u.id), login: u.login, person: u.type === 'User' };
  }
}

/** Apple's sign-in origin: where the browser signs in, the token endpoint, its keys, and every id_token's `iss`. */
export const APPLE_ORIGIN = 'https://appleid.apple.com';
/** An Apple Developer team id or key id: ten uppercase letters and digits. */
const APPLE_ID10 = /^[A-Z0-9]{10}$/;
/** A Services ID, Apple's client id for the web: a reverse-DNS identifier. */
const SERVICES_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
/** What Kolab keeps as a person's id at a provider (the identity table's subject check). */
const SUBJECT = /^[A-Za-z0-9._@|:-]{1,200}$/;
/** How long a client secret Kolab signs lasts: one token request needs seconds; Apple allows up to six months. */
const CLIENT_SECRET_S = 300;
/** Clock skew allowed when checking an id_token's times. */
const SKEW_S = 60;
/** Apple's keys are kept this long, and asked for again sooner only for a key id Kolab hasn't seen, at most once a minute. */
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_RETRY_MS = 60_000;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const json64 = (v: unknown) => b64url(JSON.stringify(v));

/**
 * The Sign in with Apple private key, as Lee puts it in SSM (/konjir/<name>/apple-signin-private-key):
 * the .p8 file Apple gives, a PKCS #8 PEM, with its lines as they are or joined by a literal `\n`,
 * or its base64 body alone. It must be an EC P-256 key, which ES256 signs with.
 */
export function applePrivateKey(text: string): KeyObject {
  const t = text.trim().replace(/\\n/g, '\n');
  const pem = t.includes('-----BEGIN') ? t : `-----BEGIN PRIVATE KEY-----\n${t.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  let key: KeyObject;
  try { key = createPrivateKey(pem); } catch { throw new Error('the Sign in with Apple private key isn\'t a PEM private key: put the .p8 file Apple gave'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('the Sign in with Apple private key isn\'t an EC P-256 key, as Apple\'s .p8 keys are');
  return key;
}

/**
 * Sign in with Apple, on the web (Lee, 2026-11-23): Apple's guideline 4.8 asks an app that signs
 * people in with a third party, as konnect's app does with GitHub on Kolab's page, to offer Sign in
 * with Apple beside it. Kolab is the OAuth client of a Services ID (`servicesId`, the client id)
 * of Lee's Apple Developer team (`teamId`), whose return URL is Kolab's callback,
 * https://<host>/oauth/callback/apple. Its client secret is a JWT Kolab signs, ES256, with a Sign in
 * with Apple key of the team's (`keyId`, `privateKey`), afresh for each token request, lasting five
 * minutes. In production these come from SSM (deploy/release/start.sh: KONJIR_APPLE_*).
 *
 * - **No scope.** Kolab asks for neither name nor email, so Apple answers with a GET redirect
 *   (`response_mode=query`) to Kolab's callback, which the binding cookie (SameSite=Lax) follows;
 *   asking for either would make Apple POST the answer cross-site (`form_post`), which it wouldn't.
 *   Kolab keeps no email. Apple gives no username either: the person chooses theirs at their first
 *   sign-in (Kolab.chooseUsername), and their avatar is their initials (Member.login is null).
 * - **Who signed in** is the id_token's `sub`, Apple's stable id for the person within the team,
 *   from the token endpoint. Kolab checks it as a relying party must, though it came straight from
 *   Apple over TLS: its RS256 signature by one of Apple's keys (/auth/keys), its issuer, its
 *   audience (the Services ID), its expiry, and its nonce.
 * - **PKCE.** Apple doesn't document PKCE for this flow, so none is sent. In its place the
 *   authorization asks for a `nonce` that is the sign-in's PKCE challenge, the sha256 of a verifier
 *   derived from the browser's binding and the provider's state (OAuthController), and `identify`
 *   accepts the id_token only if its nonce is the challenge of the verifier it is given. So a code
 *   works only in the sign-in, in the browser, it was issued for, as PKCE would make it, beside the
 *   `state` binding Kolab checks before the code goes anywhere.
 * - **No lookup**, since Apple has no usernames: an Apple account can't be invited by name. An invite
 *   link (W3.4) reaches one.
 * - **Apple's tokens are revoked at once.** Apple requires an app that offers Sign in with Apple
 *   to revoke the person's Apple tokens (POST /auth/revoke) when their account is deleted. Kolab
 *   keeps no provider token (DEL4), so it couldn't revoke one later: instead, as soon as the
 *   id_token checks out and says who signed in, `identify` revokes the refresh token Apple gave
 *   (`token_type_hint=refresh_token`), or its access token when it gave none, as the Services ID
 *   with a client secret of its own. So Kolab never holds a live Apple token, before or after an
 *   account is deleted, and nothing of Apple's is stored or passed on. Revoking ends the
 *   authorization at Apple, so Apple may ask the person again, at their next sign-in, to use their
 *   Apple Account with Kolab. It is best-effort: a revocation Apple refuses, or that can't reach
 *   Apple, is logged as a warning (`warn`), never with the token, and the sign-in goes on.
 */
export class AppleIdentity implements IdentityProvider {
  readonly id = 'apple';
  readonly label = 'Apple';
  private readonly key: KeyObject;
  private keys = new Map<string, KeyObject>();
  private keysAt = 0;
  private keysLoading?: Promise<void>;

  constructor(private readonly config: {
    servicesId: string; teamId: string; keyId: string; privateKey: string;
    /** For tests: Apple's origin, the fetch to reach it with, and the clock, in ms. */
    origin?: string; fetch?: Fetch; timeoutMs?: number; now?: () => number;
    /** Where a revocation that failed is said (Nest's logger by default): never with the token. */
    warn?: (message: string) => void;
  }) {
    if (!config.servicesId || !config.teamId || !config.keyId || !config.privateKey) throw new Error('Sign in with Apple needs the Services ID, the team id, the key id and the private key');
    if (!SERVICES_ID.test(config.servicesId)) throw new Error('the Sign in with Apple Services ID is a reverse-DNS identifier, such as com.konjir.kolab.signin');
    if (!APPLE_ID10.test(config.teamId)) throw new Error('the Apple Developer team id is ten uppercase letters and digits');
    if (!APPLE_ID10.test(config.keyId)) throw new Error('the Sign in with Apple key id is ten uppercase letters and digits');
    this.key = applePrivateKey(config.privateKey);
  }

  private get origin() { return this.config.origin ?? APPLE_ORIGIN; }
  private get fetch(): Fetch { return this.config.fetch ?? fetch; }
  private signal() { return AbortSignal.timeout(this.config.timeoutMs ?? 10_000); }
  private now() { return this.config.now?.() ?? Date.now(); }

  get authorizationOrigin() { return new URL(this.origin).origin; }

  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string; prompt?: 'select_account' }): string {
    const u = new URL('/auth/authorize', this.origin);
    u.searchParams.set('client_id', this.config.servicesId);
    u.searchParams.set('redirect_uri', p.redirectUri);
    u.searchParams.set('response_type', 'code');
    // No scope, so the answer may come as a GET: name or email would need form_post, a cross-site POST.
    u.searchParams.set('response_mode', 'query');
    u.searchParams.set('state', p.state);
    // In PKCE's place: the id_token must carry it back (identify).
    u.searchParams.set('nonce', p.codeChallenge);
    // No prompt: Apple has no account picker to ask for, and its page offers another Apple Account itself.
    return u.toString();
  }

  /** The client secret for one token request: an ES256 JWT of the team's Sign in with Apple key, for the Services ID, lasting five minutes. */
  clientSecret(): string {
    const iat = Math.floor(this.now() / 1000);
    const input = `${json64({ alg: 'ES256', kid: this.config.keyId, typ: 'JWT' })}.${json64({ iss: this.config.teamId, iat, exp: iat + CLIENT_SECRET_S, aud: APPLE_ORIGIN, sub: this.config.servicesId })}`;
    // JOSE's ES256 signature is r and s, 32 bytes each (IEEE P1363), not DER.
    return `${input}.${b64url(sign('sha256', Buffer.from(input), { key: this.key, dsaEncoding: 'ieee-p1363' }))}`;
  }

  async identify(p: { code: string; redirectUri: string; codeVerifier: string }) {
    const res = await this.fetch(new URL('/auth/token', this.origin), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.servicesId, client_secret: this.clientSecret(),
        code: p.code, grant_type: 'authorization_code', redirect_uri: p.redirectUri,
      }),
      signal: this.signal(),
    });
    const t = await res.json().catch(() => ({})) as { id_token?: unknown; access_token?: unknown; refresh_token?: unknown; error?: unknown };
    // Never the response itself in the error: it carries tokens.
    if (!res.ok || typeof t.id_token !== 'string') throw new Error(`Apple didn't accept the sign-in (${typeof t.error === 'string' ? t.error.slice(0, 80) : res.status})`);
    const claims = await this.verifyIdToken(t.id_token, createHash('sha256').update(p.codeVerifier).digest('base64url'));
    // Who signed in is known: Apple's tokens are revoked now, and dropped, never stored, logged or
    // passed on (DEL4). A code whose id_token didn't check out revokes nothing: Kolab doesn't act
    // on what it doesn't trust, and Apple's tokens of it expire on their own.
    if (typeof t.refresh_token === 'string' && t.refresh_token) await this.revoke(t.refresh_token, 'refresh_token');
    else if (typeof t.access_token === 'string' && t.access_token) await this.revoke(t.access_token, 'access_token');
    return { subject: claims.sub };
  }

  /**
   * Revokes one of Apple's tokens (POST /auth/revoke), as the Services ID with a fresh client
   * secret: best-effort, so a failure is a warning, naming the kind of token and Apple's answer,
   * never the token or Apple's body, and never an error.
   */
  private async revoke(token: string, hint: 'refresh_token' | 'access_token') {
    const warn = this.config.warn ?? ((m: string) => new Logger('OAuth').warn(m));
    try {
      const res = await this.fetch(new URL('/auth/revoke', this.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.config.servicesId, client_secret: this.clientSecret(), token, token_type_hint: hint }),
        signal: this.signal(),
      });
      const body = await res.json().catch(() => ({})) as { error?: unknown };
      if (!res.ok) warn(`Apple didn't revoke a sign-in's ${hint} (${typeof body.error === 'string' && /^[a-z_]{1,40}$/.test(body.error) ? body.error : res.status}); the sign-in goes on`);
    } catch (e) {
      warn(`Apple couldn't be asked to revoke a sign-in's ${hint} (${e instanceof Error ? e.name : 'error'}); the sign-in goes on`);
    }
  }

  /**
   * An id_token's claims, once it checks out: signed RS256 by one of Apple's keys, the one its
   * header names; issued by Apple for this Services ID; not expired, nor issued in the future (a
   * minute's skew either way); carrying `nonce`; and naming a `sub` the identity table can keep.
   * Throws otherwise, saying which, never with the token.
   */
  async verifyIdToken(token: string, nonce: string): Promise<{ sub: string }> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) throw new Error('Apple\'s id_token isn\'t a JWT');
    const [h, b, sig] = parts;
    let header: { alg?: unknown; kid?: unknown };
    let claims: { iss?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; sub?: unknown; nonce?: unknown };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    } catch { throw new Error('Apple\'s id_token isn\'t a JWT'); }
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Apple\'s id_token isn\'t signed RS256 with a key id');
    const key = await this.signingKey(header.kid);
    if (!key || !verify('sha256', Buffer.from(`${h}.${b}`), key, Buffer.from(sig, 'base64url'))) throw new Error('Apple\'s id_token isn\'t signed by Apple');
    const now = this.now() / 1000;
    if (claims?.iss !== APPLE_ORIGIN) throw new Error('Apple\'s id_token wasn\'t issued by Apple');
    if (claims.aud !== this.config.servicesId) throw new Error('Apple\'s id_token isn\'t for this Services ID');
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) throw new Error('Apple\'s id_token expired');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > now) throw new Error('Apple\'s id_token was issued in the future');
    if (claims.nonce !== nonce) throw new Error('Apple\'s id_token isn\'t for this sign-in (its nonce differs)');
    if (typeof claims.sub !== 'string' || !SUBJECT.test(claims.sub)) throw new Error('Apple\'s id_token names no usable account');
    return { sub: claims.sub };
  }

  /** Apple's public key by its id, from /auth/keys: kept an hour; an id not among them asks again, at most once a minute. */
  private async signingKey(kid: string): Promise<KeyObject | undefined> {
    const age = this.now() - this.keysAt;
    if (!this.keysAt || age > JWKS_TTL_MS || (!this.keys.has(kid) && age > JWKS_RETRY_MS)) {
      this.keysLoading ??= this.loadKeys().finally(() => { this.keysLoading = undefined; });
      await this.keysLoading;
    }
    return this.keys.get(kid);
  }

  private async loadKeys() {
    const res = await this.fetch(new URL('/auth/keys', this.origin), { headers: { accept: 'application/json' }, signal: this.signal() });
    const set = await res.json().catch(() => ({})) as { keys?: unknown };
    if (!res.ok || !Array.isArray(set.keys)) throw new Error(`Apple's signing keys couldn't be read (${res.status})`);
    const keys = new Map<string, KeyObject>();
    for (const k of set.keys as { kty?: unknown; kid?: unknown; n?: unknown; e?: unknown; use?: unknown }[]) {
      if (k?.kty !== 'RSA' || typeof k.kid !== 'string' || typeof k.n !== 'string' || typeof k.e !== 'string' || (k.use !== undefined && k.use !== 'sig')) continue;
      try { keys.set(k.kid, createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' })); } catch { /* a key Node can't read is skipped */ }
    }
    this.keys = keys;
    this.keysAt = this.now();
  }
}

/** Who a stub provider signs in: `login` left out, as Apple leaves it out. */
type StubWho = { subject: string; login?: string; name?: string };

/**
 * An identity provider for tests and local development, which signs in whoever the test says,
 * with no browser and no network: `authorizationUrl` sends the browser straight back to Kolab's
 * callback with a code for the next person queued by `next` (or `as`). Only code can configure
 * it (startServer's `identity`); `kolab serve` never does. By default it is GitHub's stand-in, with
 * logins and `lookup`; with `usernames: false` it is Apple's, under its own `id` and `label`: it
 * gives no login, so a new account's person chooses a username, and it has no `lookup`.
 */
export class StubIdentity implements IdentityProvider {
  readonly id: string;
  readonly label: string;
  private readonly logins: boolean;
  private readonly queue: StubWho[] = [];
  private readonly codes = new Map<string, { who: StubWho; redirectUri: string; challenge: string }>();
  private n = 0;
  /** Who signs in when nobody is queued; undefined to refuse. */
  as?: StubWho;

  constructor(opts: { id?: string; label?: string; usernames?: boolean } = {}) {
    this.id = opts.id ?? 'stub';
    this.label = opts.label ?? 'Stub';
    this.logins = opts.usernames !== false;
    // Looks a login up among the accounts the test made (account); `lookups` counts the calls. Apple's stand-in has none.
    this.lookup = this.logins ? async (login: string) => {
      this.lookups++;
      if (this.down) throw new Error(`the stub provider is down: it can't say who ${login} is`);
      return this.accounts.get(login.toLowerCase());
    } : undefined;
  }

  /** Accounts `lookup` finds, by login in any case: what GitHub's users would be. */
  private readonly accounts = new Map<string, { subject: string; login: string; person: boolean }>();

  /** The next sign-in is this person. */
  next(who: StubWho) { this.queue.push(who); return this; }

  /** An account `lookup` finds by its login: a person's, unless `person` is false (an organization's). */
  account(who: { subject: string; login: string; person?: boolean }) { this.accounts.set(who.login.toLowerCase(), { subject: who.subject, login: who.login, person: who.person ?? true }); return this; }

  lookups = 0;
  /** While true, `lookup` throws, as GitHub's does when it can't be asked (down, or its rate limit spent). */
  down = false;
  readonly lookup?: (login: string) => Promise<{ subject: string; login: string; person: boolean } | undefined>;

  /** The prompt each authorizationUrl was asked with, in order: what GitHub would have been asked. */
  readonly prompts: (string | undefined)[] = [];

  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string; prompt?: 'select_account' }): string {
    this.prompts.push(p.prompt);
    const who = this.queue.shift() ?? this.as;
    const u = new URL(p.redirectUri);
    u.searchParams.set('state', p.state);
    if (!who) { u.searchParams.set('error', 'access_denied'); return u.toString(); }
    const code = `${this.id}-${++this.n}`;
    this.codes.set(code, { who, redirectUri: p.redirectUri, challenge: p.codeChallenge });
    u.searchParams.set('code', code);
    return u.toString();
  }

  async identify(p: { code: string; redirectUri: string; codeVerifier: string }) {
    const c = this.codes.get(p.code);
    this.codes.delete(p.code);
    if (!c || c.redirectUri !== p.redirectUri || createHash('sha256').update(p.codeVerifier).digest('base64url') !== c.challenge) {
      throw new Error('the stub provider didn\'t issue that code');
    }
    if (this.logins) {
      if (c.who.login === undefined) throw new Error('the stub provider stands in for GitHub here: give each person a login');
      return c.who;
    }
    return { subject: c.who.subject, ...(c.who.name ? { name: c.who.name } : {}) };
  }
}
