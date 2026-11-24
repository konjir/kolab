import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Logger, Options, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessError, ActorError, ArchivedSignInError, Kolab, OAuthGrantError, RoleError, TenancyError, isReservedKolabName, maskTokens, namedAgent, onPersonsDevice, personScope, redirectUriMatches, scopeLock, setupScope, signInStep, type ConsentChoice, type TeamIntent, type TeamPlan } from '@konjir/engine';
import { isKolabName } from '@konjir/address';
import { ROLES, type Role } from '@konjir/types';
import { MCP_ROUTE, OAUTH_OPTIONS, KOLAB, type OAuthOptions } from '../tokens.js';
import { choosePage, consentPage, continuePage, formActionSource, lockAllowed, lockedTitle, sendError, sendPage, setupPage, signInPage, teamPage, usernamePage, type ChooseView, type ConsentView, type ContinueView, type SetupView, type TeamView } from './pages.js';
import type { IdentityProvider } from './identity.js';
import { oauthWording, worded, type Wording } from '../wording.js';

/** The web interface's own client: first party, never registered, and only ever a person (W3.1). */
export const WEB_CLIENT = 'konjir-web';
/** Where the web interface receives its code. */
export const WEB_CALLBACK = '/api/session/oauth/callback';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostName = (host: string) => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]).toLowerCase();

/**
 * This Kolab's own origin as a request names it: its public host behind the TLS proxy, https;
 * or a loopback address, http, port and all. The issuer, the endpoints and the MCP resource are
 * all on it. Any other Host is refused (undefined), as /mcp and /api refuse it (DNS rebinding).
 */
export function originOf(req: Request, options: { publicHost?: string }): string | undefined {
  const host = req.headers.host ?? '';
  const name = hostName(host);
  const pub = options.publicHost?.toLowerCase();
  if (pub && name === pub) return `https://${pub}`;
  if (LOOPBACK.has(name) && /^[A-Za-z0-9.:[\]-]+$/.test(host)) return `http://${host.toLowerCase()}`;
  return undefined;
}

/**
 * The binding cookie of an authorization in progress, sent back by the identity provider's
 * redirect (Lax). Behind the TLS proxy it is `__Host-` (Secure, Path=/, no Domain), so no other
 * host under the same domain can toss one in its place; on loopback, scoped to /oauth. One per
 * sign-in, named by the sign-in's id, `konjir_oauth_<id>`: two sign-ins in one browser, an MCP
 * client's and the web page's say, each keep their own and never overwrite the other's. The id
 * isn't secret (the binding is): it rides in the identity provider's state, `<id>.<state>`, and in
 * the consent form, so the callback and the consent find their sign-in's cookie.
 */
const bindingPrefix = (options: { publicHost?: string }) => (options.publicHost ? '__Host-konjir_oauth_' : 'konjir_oauth_');
const bindingCookie = (options: OAuthOptions, id: string) => `${bindingPrefix(options)}${id}`;
const SIGN_IN_ID = /^[A-Za-z0-9_-]{11}$/;
/**
 * At most this many sign-ins open in one browser at once, each a cookie of about 80 bytes on every
 * request to Kolab. A new sign-in always goes ahead: at the cap, the oldest are let go to make
 * room, so no other site, sending the browser to /oauth/authorize over and over, can lock its
 * person out. One let go says, at its consent form, that it didn't start in this browser.
 */
export const OPEN_SIGN_INS = 10;
/** The binding cookies a request carries: each sign-in's id and binding. */
function bindingsOf(req: Request, options: { publicHost?: string }): { id: string; binding: string }[] {
  const prefix = bindingPrefix(options);
  const out: { id: string; binding: string }[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (i > 0 && name.startsWith(prefix) && SIGN_IN_ID.test(name.slice(prefix.length)) && value) out.push({ id: name.slice(prefix.length), binding: value });
  }
  return out;
}
export const bindingCookieAttrs = (options: { publicHost?: string }, path: string) => (options.publicHost ? 'Path=/; Secure' : `Path=${path}`);

/**
 * The invite a person opened, carried from the web page to Kolab's own sign-in (W3.4): set by
 * POST /api/session/invite once Kolab has checked it, read only by /oauth/authorize for the web
 * interface's own client, and cleared once the person consents. HttpOnly, SameSite=Lax (it must
 * survive the identity provider's redirect), for as long as a sign-in may take; behind the TLS proxy
 * `__Host-` (Secure, Path=/, no Domain), so no other host under the domain can plant one, and on
 * loopback scoped to /oauth.
 */
export const inviteCookie = (options: { publicHost?: string }) => (options.publicHost ? '__Host-konjir_invite' : 'konjir_invite');
export const setInviteCookie = (res: Response, options: { publicHost?: string }, token: string, maxAgeS: number) =>
  res.append('set-cookie', `${inviteCookie(options)}=${token}; ${bindingCookieAttrs(options, '/oauth')}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}`);
export const clearInviteCookie = (res: Response, options: { publicHost?: string }) =>
  res.append('set-cookie', `${inviteCookie(options)}=; ${bindingCookieAttrs(options, '/oauth')}; HttpOnly; SameSite=Lax; Max-Age=0`);

export function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()) || undefined; } catch { return undefined; }
    }
  }
  return undefined;
}

/**
 * The PKCE verifier of Kolab's own request to the identity provider: derived from the binding, which
 * only the browser holds, and that request's state, so each request (a restart's for another
 * account included, restartIdentification) has a verifier of its own.
 */
const providerVerifier = (binding: string, state: string) => createHash('sha256').update(`konjir-idp:${binding}:${state}`).digest('base64url');
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** How long a sign-in lasts, in words. */
const lasting = (ttlS: number) => (ttlS % 60 ? `${ttlS} seconds` : `${ttlS / 60} minutes`);
/** What the person is told when a sign-in can't go on, by what became of it (Kolab.signInStatus). */
const EXPIRED = (ttlS: number) => `This sign-in expired: it lasts ${lasting(ttlS)} from when the app opened it. Start again from the app you were connecting.`;
const CLAIMED = 'This sign-in is being allowed right now: it can\'t be denied or allowed again meanwhile. Return to the app you were connecting, which says how it went.';
const USED = 'This sign-in was already used: it was allowed, denied or cancelled. If the app you were connecting isn\'t signed in, start again from there.';
/** What a `choose:kolab` sign-in's app is told when its page had nothing to choose: no invitation for the account, and no kolab of the person's. */
export const NOTHING_TO_CHOOSE = 'nothing to sign in to: no invitation waits for this account, and it is a member of no kolab. Make a team, or ask a team\'s owner to invite this GitHub account';
/** The same, for an account of a provider no one can invite by name (Apple's, which has no lookup): an invite link reaches it (W3.4). */
export const NOTHING_TO_CHOOSE_UNINVITABLE = 'nothing to sign in to: this account is a member of no kolab, and an account signed in with Apple can\'t be invited by name. Make a team, or ask a team\'s owner for an invite link from Kolab\'s web page';
const nothingToChoose = (idp: IdentityProvider | undefined) => (idp && !idp.lookup ? NOTHING_TO_CHOOSE_UNINVITABLE : NOTHING_TO_CHOOSE);
const NOT_HERE = `This sign-in didn't start in this browser, or the browser let it go: it holds ${OPEN_SIGN_INS} sign-ins at most, and newer ones took its place. Finish it in the browser the app opened, or start again from the app you were connecting.`;

/**
 * At most `perKey` calls in `windowMs` for any one key (a client address), and at most `total` in
 * all, per process: one caller can't use up everyone's budget, and the total is a backstop. All
 * are checked before any is taken, so a refused call spends nothing. Keys idle for a window are
 * forgotten.
 */
/** How long GitHub's answer for a username chosen at an Apple sign-up is kept (`usernameAnswers`). */
const USERNAME_ANSWER_MS = 10 * 60_000;

export class Limit {
  private readonly byKey = new Map<string, number[]>();
  private all: number[] = [];
  constructor(private readonly perKey: number, private readonly total: number, private readonly windowMs: number) {}
  take(...keys: (string | undefined)[]): boolean {
    if (keys.some((k) => k === undefined)) return false;
    const now = Date.now();
    const live = (ts: number[] | undefined) => (ts ?? []).filter((t) => now - t < this.windowMs);
    this.all = live(this.all);
    if (this.all.length >= this.total) return false;
    const each = keys.map((k) => live(this.byKey.get(k!)));
    if (each.some((ts) => ts.length >= this.perKey)) return false;
    keys.forEach((k, i) => this.byKey.set(k!, [...each[i], now]));
    this.all.push(now);
    if (this.byKey.size > 10_000) for (const [k, ts] of this.byKey) if (!live(ts).length) this.byKey.delete(k);
    return true;
  }
}

/**
 * The address a request comes from. Behind the TLS proxy (Caddy, on loopback), the last entry of
 * X-Forwarded-For, which the proxy writes with the address it saw and doesn't take from the
 * client; otherwise the socket's own address.
 */
export function clientAddress(req: Request, options: { publicHost?: string }): string | undefined {
  const socket = req.socket?.remoteAddress ?? '';
  const viaProxy = !!options.publicHost && /^(127\.|::1$|::ffff:127\.)/.test(socket);
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').pop()?.trim() : undefined;
  const address = viaProxy && forwarded ? forwarded : socket;
  // No address to count it by (a socket already gone): refused, never one bucket everyone shares.
  return address ? `ip:${addressKey(address)}` : undefined;
}

/**
 * The key a client address is limited by: an IPv4 address as it is (an IPv4-mapped IPv6 one too),
 * and an IPv6 address by its /64, which one host or network can fill with addresses of its own.
 */
export function addressKey(address: string): string {
  const a = address.trim().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The scope a client asks with may name what to preselect on the consent page (D59): a kolab and a
 * role, `kolab:<name> role:<role>`, and who the client works as, `agent:<id>` (an agent of the
 * person's). It only preselects: the page honours each word only for a choice the person signing
 * in has anyway (consent), and the person confirms there. No client preselects the person (D60):
 * `as:self` is ignored, from any client, and the person chooses Yourself by hand.
 */
export function preselect(scope: string | null | undefined): { kolab?: string; role?: Role; agent?: string } {
  const words = (scope ?? '').split(/\s+/);
  const kolab = words.find((w) => w.startsWith('kolab:'))?.slice(6);
  const role = words.find((w) => w.startsWith('role:'))?.slice(5) as Role | undefined;
  const agent = words.find((w) => w.startsWith('agent:'))?.slice(6);
  return { kolab, role: role && ROLES.includes(role) ? role : undefined, agent: agent || undefined };
}

const json = (res: Response, status: number, body: unknown) => {
  res.status(status);
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.json(body);
};
const oauthError = (res: Response, status: number, error: string, description: string) =>
  json(res, status, { error, error_description: maskTokens(description) });

/** Who may call the JSON endpoints from a browser: anyone, since no cookie is used there. */
function cors(res: Response) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version');
  res.setHeader('access-control-max-age', '600');
}

/**
 * Kolab as an OAuth 2.1 authorization server for its MCP endpoint and the web interface (D55;
 * RUN3), with the person's identity from an identity provider (GitHub). It follows the MCP
 * authorization spec for remote servers (2025-06-18 and 2026-07-28):
 *
 * - **Discovery.** /mcp answers a request without a token with 401 and a `WWW-Authenticate`
 *   naming its protected-resource metadata (RFC 9728), which @onivoro/server-mcp sends. That
 *   names Kolab itself as the authorization server, whose metadata (RFC 8414) lists the
 *   endpoints below. The issuer is Kolab's own origin.
 * - **Clients** register dynamically (RFC 7591), as public clients with no secret. The web
 *   interface is Kolab's own client, `konjir-web`, and can't be used by anyone else's page.
 * - **Authorization code with PKCE**, S256 only, with exact redirect URIs (a loopback one may
 *   change its port, RFC 8252), the client's `state` passed back and the issuer in `iss`
 *   (RFC 9207). The person signs in at the identity provider, which Kolab reaches as an OAuth
 *   client of its own, with its own state and PKCE, bound to the browser by a cookie; then they
 *   consent, choosing who the client acts as, in which kolab and role.
 * - **Tokens.** An access token is a session token that lasts 15 minutes; a refresh token
 *   rotates at each use, and a replayed one revokes its grant. Kolab stores only their hashes.
 *   Revoking either (RFC 7009) ends the session, and its streams close (D41).
 */
@Controller()
export class OAuthController {
  private readonly logger = new Logger('OAuth');
  /** Registrations: 10 an hour from one address, 500 in all. */
  private readonly registrations = new Limit(10, 500, 60 * 60_000);
  /**
   * Authorizations of a known client at a registered redirect URI: 30 a minute from one address
   * (an IPv6 /64), and no total, nor any limit per client: a client id is public (the web
   * interface's above all), and a shared bucket would let a few addresses lock everyone out.
   */
  private readonly authorizations = new Limit(30, Infinity, 60_000);
  /**
   * The identity provider's answers, and consent forms: each 30 a minute from one address, counted
   * before Kolab looks anything up, as authorizations are.
   */
  private readonly callbacks = new Limit(30, Infinity, 60_000);
  private readonly consents = new Limit(30, Infinity, 60_000);
  /** A setup token's one use (POST /oauth/setup): 30 a minute from one address, as consents. */
  private readonly setupUses = new Limit(30, Infinity, 60_000);
  /**
   * Usernames chosen at a first Sign in with Apple, checked with GitHub (POST /oauth/username): 30
   * an hour from one address, 10 an hour for one sign-in (each needs an Apple sign-in of its own, so
   * no one spends the total for everyone from a single one), 3,000 in all, from the OAuth app's one
   * rate limit (5,000 an hour), which invitations by account share. Past it, a name isn't checked,
   * so it isn't taken: the page says to try again. GitHub's answer for a name is kept 10 minutes
   * (`usernameAnswers`), so asking again costs nothing.
   */
  private readonly usernameLookups = new Limit(30, 3000, 60 * 60_000);
  private readonly usernameLookupsPerSignIn = new Limit(10, Infinity, 60 * 60_000);
  private readonly usernameAnswers = new Map<string, { at: number; answer: Awaited<ReturnType<NonNullable<IdentityProvider['lookup']>>> }>();

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(OAUTH_OPTIONS) private readonly options: OAuthOptions,
  ) {}

  /** The identity providers, in the order the sign-in page offers them. */
  private get idps() { return this.options.identities; }
  /** The provider of that id, if this Kolab has it. */
  private providerOf(id: string | undefined) { return this.idps.find((i) => i.id === id); }
  /** What a provider is called on the pages: its label, or its id for one no longer set up. */
  private labelOf(id: string) { return this.providerOf(id)?.label ?? id; }

  // ---- metadata ---------------------------------------------------------------

  @Get(['.well-known/oauth-protected-resource', `.well-known/oauth-protected-resource/${MCP_ROUTE}`])
  protectedResource(@Req() req: Request, @Res() res: Response) {
    cors(res);
    const base = originOf(req, this.options);
    if (!base || !this.idps.length) return json(res, 404, { error: 'not_found' });
    // No scopes_supported here (RFC 9728 makes it optional): an MCP client asks with the scope its
    // configuration gives only when the resource names none (MCP's scope selection), and a scope is
    // how a harness's configuration preselects its agent, kolab and role at consent (D59). Kolab
    // requires no scope of a client.
    json(res, 200, {
      resource: `${base}/${MCP_ROUTE}`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_name: 'Kolab',
    });
  }

  @Get('.well-known/oauth-authorization-server')
  authorizationServer(@Req() req: Request, @Res() res: Response) {
    cors(res);
    const base = originOf(req, this.options);
    if (!base || !this.idps.length) return json(res, 404, { error: 'not_found' });
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['konjir'],
      authorization_response_iss_parameter_supported: true,
    });
  }

  @Options(['.well-known/oauth-protected-resource', `.well-known/oauth-protected-resource/${MCP_ROUTE}`, '.well-known/oauth-authorization-server', 'oauth/token', 'oauth/register', 'oauth/revoke'])
  @HttpCode(204)
  preflight(@Res({ passthrough: true }) res: Response) { cors(res); }

  // ---- registration (RFC 7591) ---------------------------------------------------

  @Post('oauth/register')
  async register(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    cors(res);
    if (!originOf(req, this.options) || !this.idps.length) return json(res, 404, { error: 'not_found' });
    if (!this.registrations.take(clientAddress(req, this.options))) return oauthError(res, 429, 'temporarily_unavailable', 'too many clients registered from here just now; try again later');
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.every((u) => typeof u === 'string')) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is a list of URIs');
    const grants = body.grant_types ?? ['authorization_code'];
    if (!Array.isArray(grants) || grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
      return oauthError(res, 400, 'invalid_client_metadata', 'grant_types are authorization_code and refresh_token');
    }
    const types = body.response_types ?? ['code'];
    if (!Array.isArray(types) || types.some((t) => t !== 'code')) return oauthError(res, 400, 'invalid_client_metadata', 'the only response type is code');
    const method = body.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') return oauthError(res, 400, 'invalid_client_metadata', 'Kolab registers public clients only: token_endpoint_auth_method none, with PKCE');
    try {
      const c = await this.kolab.registerClient({ name: typeof body.client_name === 'string' ? body.client_name : undefined, redirectUris: uris as string[] });
      json(res, 201, {
        client_id: c.id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: c.name, redirect_uris: c.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      });
    } catch (e) {
      if (e instanceof OAuthGrantError) return oauthError(res, 400, e.code, e.message);
      throw e;
    }
  }

  // ---- authorization -----------------------------------------------------------

  /** The client, and the redirect URIs it may receive codes at: the web interface's, or a registered client's. `use` marks it used. */
  private async client(id: string, base: string, use = false): Promise<{ name: string; redirectUris: string[]; web: boolean } | undefined> {
    if (id === WEB_CLIENT) return { name: 'Kolab\'s web page', redirectUris: [`${base}${WEB_CALLBACK}`], web: true };
    const c = id.startsWith('kjcl_') ? await this.kolab.oauthClient(id, { use }) : undefined;
    return c && { name: c.name, redirectUris: c.redirectUris, web: false };
  }

  /**
   * How a sign-in's pages, and what its app is told, name the CLI's commands (wording.ts): by the
   * name the client registered with, `kolab` for the kolab CLI's, `konjir` for any other, published
   * konnect's and konjir's among them, and for one unknown. Kolab's own web page is always current.
   */
  private async wordingOf(clientId: string): Promise<Wording> {
    if (clientId === WEB_CLIENT) return 'kolab';
    return oauthWording((await this.client(clientId, ''))?.name);
  }

  @Get('oauth/authorize')
  async authorize(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base) return sendError(res, 403, 'This Kolab doesn\'t serve that host.');
    if (!this.idps.length) return sendError(res, 404, 'Signing in with an identity provider isn\'t set up on this Kolab.');
    const str = (k: string) => (typeof q[k] === 'string' ? q[k] as string : undefined);
    const clientId = str('client_id');
    const redirectUri = str('redirect_uri');
    // Nothing is redirected anywhere before the person has seen the consent page: not until the
    // client and its redirect URI check out (RFC 6749 §4.1.2.1), and not for an error after that
    // either, since anyone can register a client with any https redirect URI (RFC 9700 §4.11.2).
    // Each error is a page that says what went wrong.
    const client = clientId ? await this.client(clientId, base, true) : undefined;
    if (!client) return sendError(res, 400, 'The app asked to sign in as a client this Kolab doesn\'t know. Reconnect it to register again.');
    if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri, this.kolab.appRedirects.devSchemes)) return sendError(res, 400, 'The app asked for its answer at an address it didn\'t register, so Kolab won\'t send it there.');
    // Counted only once the client checks out, per address and per client.
    if (!this.authorizations.take(clientAddress(req, this.options))) {
      return sendError(res, 429, 'Too many sign-ins just now; try again in a minute.');
    }
    const state = str('state');
    const refuse = (description: string) => sendError(res, 400, `The app's sign-in request isn't one Kolab accepts: ${description}. Tell whoever makes the app.`);
    if (str('response_type') !== 'code') return refuse('the only response type is code');
    const challenge = str('code_challenge');
    if (!challenge || str('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return refuse('PKCE is required, with an S256 code_challenge');
    }
    const resource = str('resource');
    if (resource !== undefined && !client.web && resource.replace(/\/$/, '') !== `${base}/${MCP_ROUTE}`) {
      return refuse(`this authorization server issues tokens for ${base}/${MCP_ROUTE} only`);
    }
    if ((state?.length ?? 0) > 1000 || (str('scope')?.length ?? 0) > 1000) return refuse('state and scope are at most 1000 characters');
    // With one identity provider the browser goes straight there. With several, Kolab's own sign-in
    // page offers a button for each, Sign in with Apple first and as Apple's guidelines draw it:
    // each links to this same request, naming its provider (`provider`), which only picks where the
    // person signs in.
    const idp = this.idps.length === 1 ? this.idps[0] : this.providerOf(str('provider'));
    if (!idp) {
      const here = new URL(req.originalUrl, base);
      const providers = this.idps.map((i) => {
        here.searchParams.set('provider', i.id);
        return { id: i.id, label: i.label, href: `${here.pathname}${here.search}` };
      });
      return sendPage(res, 200, 'Sign in', signInPage({ client: client.name, web: client.web, redirect: redirectShown(redirectUri), providers }));
    }
    // Only the web interface's own sign-in carries an invite (W3.4), from the cookie its page set.
    const invite = client.web ? cookieOf(req, inviteCookie(this.options)) : undefined;
    await this.toIdentityProvider(req, res, base, idp, {
      clientId: clientId!, redirectUri, clientState: state, codeChallenge: challenge, scope: str('scope'), resource, invite,
      // Which of several sign-ins this is (`kolab connect`'s "agent N of M"): display only, kept
      // only when both are whole numbers, never part of the scope, so it grants nothing. Only from
      // an app on the person's own machine (every redirect URI loopback, as kolab's are): from a
      // hosted one it would dress a lure up as a setup the person started, so it is ignored (D97).
      step: client.web || !client.redirectUris.every(onLoopback) ? null : signInStep(q.step, q.steps),
    });
  }

  /**
   * Starts a sign-in in this browser and sends it to the identity provider: a binding cookie of its
   * own, and the provider's state naming it (D57). At the cap, the oldest sign-ins in this browser
   * are let go, so this one has room.
   */
  private async toIdentityProvider(req: Request, res: Response, base: string, idp: IdentityProvider,
    r: Omit<Parameters<Kolab['beginAuthorization']>[0], 'provider'>) {
    const held = bindingsOf(req, this.options);
    const evict: string[] = [];
    if (held.length >= OPEN_SIGN_INS) {
      const oldest = await this.kolab.signInsByAge(held.map((h) => h.binding));
      const drop = new Set(oldest.slice(0, held.length - OPEN_SIGN_INS + 1));
      for (const h of held) if (drop.has(h.binding)) evict.push(h.id);
    }
    const { binding, state: idpState } = await this.kolab.beginAuthorization({ provider: idp.id, ...r });
    const id = randomBytes(8).toString('base64url');
    for (const old of evict) clearBinding(res, this.options, old);
    res.append('set-cookie', `${bindingCookie(this.options, id)}=${binding}; ${bindingCookieAttrs(this.options, '/oauth')}; HttpOnly; SameSite=Lax; Max-Age=${this.kolab.oauth.requestTtlS}`);
    res.setHeader('referrer-policy', 'no-referrer');
    res.redirect(302, idp.authorizationUrl({
      redirectUri: `${base}/oauth/callback/${idp.id}`, state: `${id}.${idpState}`, codeChallenge: s256(providerVerifier(binding, idpState)),
    }));
  }

  /** The identity provider's answer: who signed in. Then the consent page. */
  @Get('oauth/callback/:provider')
  async callback(@Req() req: Request, @Res() res: Response, @Param('provider') provider: string, @Query() q: Record<string, unknown>) {
    const base = originOf(req, this.options);
    const idp = this.providerOf(provider);
    if (!base || !idp) return sendError(res, 404, 'No such sign-in.');
    if (!this.callbacks.take(clientAddress(req, this.options))) return sendError(res, 429, 'Too many sign-ins just now; try again in a minute.');
    // The provider's state is `<id>.<state>`: the sign-in's id names its cookie.
    const full = typeof q.state === 'string' ? q.state : '';
    const dot = full.indexOf('.');
    const id = dot < 0 ? '' : full.slice(0, dot);
    const state = dot < 0 ? '' : full.slice(dot + 1);
    if (!SIGN_IN_ID.test(id) || !state) return sendError(res, 400, `${idp.label}'s answer doesn't name a sign-in of Kolab's. Start again from the app you were connecting.`);
    const binding = cookieOf(req, bindingCookie(this.options, id));
    if (!binding) return this.stopped(res, { state });
    // The binding and the state together, before the code goes anywhere (RFC 6749 §10.12).
    const pending = await this.kolab.pendingAuthorization(binding, { state });
    // Only the provider the sign-in was sent to answers it, a cancel included: another provider's
    // callback can't end it.
    if (pending && pending.provider !== idp.id) return sendError(res, 400, `This sign-in was sent to ${this.labelOf(pending.provider)}, not ${idp.label}. Start again from the app you were connecting.`);
    if (typeof q.error === 'string' || typeof q.code !== 'string') {
      const r = await this.kolab.abandonAuthorization(binding, state);
      if (!r) return this.stopped(res, { binding }, id);
      // Cancelled: the sign-in is over, and its cookie goes with it.
      clearBinding(res, this.options, id);
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: `the sign-in with ${idp.label} was cancelled`, state: r.clientState ?? undefined, iss: base }));
    }
    if (!pending) return this.stopped(res, { binding }, id);
    // The provider's answer came back a second time (the page reloaded, say): it counts once.
    if (pending.person || pending.choosingUsername) return sendError(res, 400, `${idp.label}'s answer for this sign-in was already used. Go back to the page it showed, or start again from the app you were connecting.`);
    let who;
    try {
      who = await idp.identify({ code: q.code, redirectUri: `${base}/oauth/callback/${idp.id}`, codeVerifier: providerVerifier(binding, state) });
    } catch (e) {
      this.logger.warn(`a sign-in with ${idp.label} failed: ${maskTokens(e)}`);
      return sendError(res, 502, `${idp.label} didn't confirm who signed in. Try again.`);
    }
    let person: { actor: string; created: boolean };
    try {
      if (who.login === undefined) {
        // A provider with no usernames (Apple): its account is a person already, found by the
        // provider's id alone, never by any name; or it is new, and the person chooses their
        // username before anyone is made (chooseUsername).
        const known = await this.kolab.signInKnown({ provider: idp.id, subject: who.subject });
        if (!known) {
          const { csrf } = await this.kolab.awaitUsername(binding, state, who.subject);
          return await this.usernamePage(res, 200, id, binding, csrf, {});
        }
        person = { actor: known, created: false };
      } else {
        person = await this.kolab.signInWith({ provider: idp.id, subject: who.subject, login: who.login, name: who.name });
      }
    } catch (e) {
      if (e instanceof ActorError) return sendError(res, 403, e.message);
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message);
      throw e;
    }
    let csrf: string;
    try {
      ({ csrf } = await this.kolab.identifyAuthorization(binding, state, person.actor));
    } catch (e) {
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message);
      throw e;
    }
    await this.consent(res, 200, id, binding, csrf, { login: who.login, created: person.created });
  }

  /**
   * Whether a pending sign-in is konnect's own app's on `choose:kolab` (its redirect URI one of the
   * app's, its client's every one the app's): its page is about who signed in alone (continuePage).
   */
  private async appChoose(pending: { clientId: string; redirectUri: string; scope: string | null } | undefined): Promise<boolean> {
    if (!pending || pending.clientId === WEB_CLIENT || !this.kolab.appRedirect(pending.redirectUri)) return false;
    const scope = personScope(pending.scope);
    if (!scope || !('choose' in scope)) return false;
    const client = await this.client(pending.clientId, '');
    return !!client && onPersonsDevice(client.redirectUris, this.kolab.appRedirects.devSchemes);
  }

  /**
   * konnect's own app signing in on `choose:kolab`, for a person with a team (Lee's design of
   * 2026-11-21): a page about the GitHub identity alone, *Continue as @<login>*, with the app's name
   * and redirect URI and a Konjir admin's warning as every person's page has them, and *Use a
   * different GitHub account*. It names and chooses no team: the app shows and changes that itself
   * (konjir_list_my_teams, konjir_switch_team, konjir_accept_invitation, konjir_make_team).
   * Continue posts the page's form, so nothing goes to the app without that tap (personConsented).
   * A person with no team gets the chooser, which offers to make a team or accept an invitation,
   * since a session must be in a kolab. Every other client sees its page as before. It is the page
   * consent shows for such a sign-in whenever it shows one: as the identity provider answers, and
   * again with an error. Returns whether it answered.
   */
  private async signInApp(res: Response, status: number, id: string, binding: string, csrf: string, extra: { login?: string; created?: boolean; error?: string }): Promise<boolean> {
    const pending = await this.kolab.pendingAuthorization(binding);
    if (!pending?.person || !(await this.appChoose(pending))) return false;
    if (!(await this.kolab.appSignInKolab(pending.person))) return false;
    const client = await this.client(pending.clientId, '');
    const login = extra.login ?? (await this.kolab.identities(pending.person)).find((i) => i.provider === pending.provider)?.login ?? pending.person;
    const view: ContinueView = {
      signIn: id, csrf, client: client?.name ?? 'An app', redirect: redirectShown(pending.redirectUri), native: true, person: pending.person, login, provider: this.labelOf(pending.provider),
      invitable: !!this.providerOf(pending.provider)?.lookup, created: !!extra.created, konjirAdmin: await this.kolab.isAdmin(pending.person), error: extra.error,
    };
    // Its forms lead on to the app (Continue) and to the identity provider (another account).
    const targets = [formActionSource(pending.redirectUri), this.providerOf(pending.provider)?.authorizationOrigin].filter((t): t is string => !!t);
    sendPage(res, status, `Continue as @${login}`, continuePage(view), { formTargets: targets });
    return true;
  }

  /**
   * The answer to konnect's app's page (signInApp), from its own form, already checked for Kolab's
   * origin, its token and this browser's binding: `continue` opens the session where Kolab says
   * (appSignInKolab) through consentPerson, as a choice on the chooser does, and sends the code to
   * the app; `other-account` forgets who signed in (restartIdentification) and asks the identity
   * provider again, with `prompt=select_account`, for the same sign-in: its client, redirect URI,
   * state and PKCE challenge stay, the provider's request gets a new state and verifier, and its
   * page is shown again for whoever signs in. Pressed again before the provider answers, it asks
   * again (consented). Undefined for any other answer, which the chooser's handling takes.
   */
  private async appAnswered(res: Response, base: string, s: { id: string; binding: string; csrf: string; person: string; provider: string }, pick: string): Promise<true | undefined> {
    if (pick === 'other-account') {
      // The provider this sign-in was sent to: the page offered another account of that one.
      const idp = this.providerOf(s.provider);
      if (!idp) { sendError(res, 400, `Signing in with ${s.provider} isn't set up on this Kolab any more. Start again from the app you were connecting.`); return true; }
      let state: string;
      try {
        ({ state } = await this.kolab.restartIdentification(s.binding, s.csrf));
      } catch (e) {
        if (e instanceof OAuthGrantError) { sendError(res, 400, e.message); return true; }
        throw e;
      }
      res.setHeader('referrer-policy', 'no-referrer');
      res.redirect(303, idp.authorizationUrl({
        redirectUri: `${base}/oauth/callback/${idp.id}`, state: `${s.id}.${state}`, codeChallenge: s256(providerVerifier(s.binding, state)), prompt: 'select_account',
      }));
      return true;
    }
    if (pick !== 'continue') return undefined;
    const kolab = await this.kolab.appSignInKolab(s.person);
    // A team gone since the page was shown, and none left: the chooser, which offers to make one.
    if (!kolab) { await this.consent(res, 200, s.id, s.binding, s.csrf, {}); return true; }
    try {
      const r = await this.kolab.consentPerson(s.binding, s.csrf, { kolab });
      clearBinding(res, this.options, s.id);
      res.redirect(303, withParams(r.redirectUri, { code: r.code, state: r.clientState ?? undefined, iss: base }));
    } catch (e) {
      if (e instanceof OAuthGrantError) { sendError(res, 400, e.message); return true; }
      if (e instanceof AccessError || e instanceof ActorError || e instanceof TenancyError || e instanceof RoleError) {
        await this.consent(res, 400, s.id, s.binding, s.csrf, { error: maskTokens(e) });
        return true;
      }
      throw e;
    }
    return true;
  }

  /**
   * A sign-in that can't go on, and why, as plainly as Kolab can tell: it expired, it was used, or
   * it is still open but not in this browser. `by` is whichever of its secrets the request carried.
   * `id` names the sign-in whose cookie the request carried: one that expired or was used is over,
   * and its cookie is cleared, so it holds no place under the cap.
   */
  private async stopped(res: Response, by: Parameters<Kolab['signInStatus']>[0], id?: string) {
    const status = await this.kolab.signInStatus(by);
    if (id && status !== 'open' && status !== 'claimed') clearBinding(res, this.options, id);
    return sendError(res, 400, status === 'expired' ? EXPIRED(this.kolab.oauth.requestTtlS) : status === 'open' ? NOT_HERE : status === 'claimed' ? CLAIMED : USED);
  }

  /**
   * The page of a first sign-in with a provider that gives no username (Apple), while it waits for
   * one (awaitUsername): who signed in, the app asking, and the username to choose, with what
   * Kolab couldn't take of the last one (`error`). Continue posts it to /oauth/username, where
   * chooseUsername makes the person; Cancel ends the sign-in and tells the app.
   */
  private async usernamePage(res: Response, status: number, id: string, binding: string, csrf: string, extra: { username?: string; error?: string }) {
    const pending = await this.kolab.pendingAuthorization(binding);
    if (!pending?.choosingUsername) return this.stopped(res, { binding }, id);
    const client = await this.client(pending.clientId, '');
    // Cancel leads on to the client's redirect URI.
    const target = formActionSource(pending.redirectUri);
    sendPage(res, status, 'Choose your username', usernamePage({
      signIn: id, csrf, client: client?.name ?? 'An app', web: pending.clientId === WEB_CLIENT, redirect: redirectShown(pending.redirectUri),
      provider: this.labelOf(pending.provider), username: extra.username, error: extra.error,
    }), { formTargets: target ? [target] : [] });
  }

  /**
   * The username a person chose at their first sign-in with a provider that gives none (Apple),
   * from its page's own form: Kolab's origin, its token and this browser's binding, as the consent
   * form. `decision=choose` makes the person, named exactly that (Kolab.chooseUsername: never an
   * existing person's name, never someone's agent's, never a GitHub account's while GitHub's
   * sign-in is here), and shows the sign-in's consent page, as the provider's answer does for
   * anyone else; a name Kolab can't take shows the page again, saying why. The same form posted
   * again shows the consent page of the person it made. A person archived meanwhile is stopped
   * with 403, as the callback stops them. Anything else cancels the sign-in, and the app is told.
   */
  @Post('oauth/username')
  async username(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base || !this.idps.length) return sendError(res, 404, 'No such sign-in.');
    if (req.headers.origin !== base) return sendError(res, 403, 'A username must be chosen on Kolab\'s own page.');
    if (!this.consents.take(clientAddress(req, this.options))) return sendError(res, 429, 'Too many sign-ins just now; try again in a minute.');
    const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : '');
    const csrf = str('csrf');
    const id = str('sign_in');
    if (!csrf || !SIGN_IN_ID.test(id)) return sendError(res, 400, 'The form arrived without its sign-in. Start again from the app you were connecting.');
    const binding = cookieOf(req, bindingCookie(this.options, id));
    if (!binding) return this.stopped(res, { csrf });
    const pending = await this.kolab.pendingAuthorization(binding, { csrf });
    // Waiting for a username; or named already by this same form, posted again (Continue pressed
    // twice, or Back and Continue), which chooseUsername answers with whoever it named.
    if (!pending || (!pending.choosingUsername && !pending.person)) return this.stopped(res, { binding }, id);
    if (str('decision') !== 'choose') {
      const r = await this.kolab.declineAuthorization(binding, csrf);
      if (!r) return this.stopped(res, { binding }, id);
      clearBinding(res, this.options, id);
      if (pending.inviteKey) clearInviteCookie(res, this.options);
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: 'the person cancelled the sign-in', state: r.clientState ?? undefined, iss: base }));
    }
    // A GitHub username stays that GitHub account's (checkUsername): GitHub's sign-in, when this
    // Kolab has it, says whether the name is one, at most usernameLookups' share of its rate limit.
    const github = this.idps.find((i) => i.lookup && i.id !== pending.provider);
    const address = clientAddress(req, this.options);
    const lookup = github?.lookup && (async (login: string) => {
      const key = login.toLowerCase(), now = Date.now();
      const kept = this.usernameAnswers.get(key);
      if (kept && now - kept.at < USERNAME_ANSWER_MS) return kept.answer;
      if (!this.usernameLookupsPerSignIn.take(`binding:${createHash('sha256').update(binding).digest('base64url')}`) || !this.usernameLookups.take(address)) throw new Error('too many usernames checked just now');
      const answer = await github.lookup!(login);
      if (this.usernameAnswers.size >= 10_000) for (const [k, v] of this.usernameAnswers) if (now - v.at >= USERNAME_ANSWER_MS) this.usernameAnswers.delete(k);
      if (this.usernameAnswers.size < 10_000) this.usernameAnswers.set(key, { at: now, answer });
      return answer;
    });
    let made: { actor: string; created: boolean; csrf: string };
    try {
      made = await this.kolab.chooseUsername(binding, csrf, str('username'), lookup ? { github: lookup } : {});
    } catch (e) {
      // Archived meanwhile (the same account, signed in elsewhere and archived): stopped, as the callback stops it.
      if (e instanceof ArchivedSignInError) return sendError(res, 403, e.message);
      if (e instanceof ActorError) return this.usernamePage(res, 400, id, binding, csrf, { username: str('username').slice(0, 39), error: e.message });
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message);
      throw e;
    }
    await this.consent(res, 200, id, binding, made.csrf, { created: made.created });
  }

  private async consent(res: Response, status: number, id: string, binding: string, csrf: string, extra: { login?: string; created?: boolean; error?: string; pick?: ConsentView['pick']; note?: string }) {
    const pending = await this.kolab.pendingAuthorization(binding);
    if (!pending?.person) return this.stopped(res, { binding }, id);
    const client = await this.client(pending.clientId, '');
    const web = pending.clientId === WEB_CLIENT;
    if (!web && setupScope(pending.scope)) return this.setupConsent(res, status, id, csrf, pending, client, extra);
    if (!web && await this.signInApp(res, status, id, binding, csrf, extra)) return;
    if (!web && personScope(pending.scope)) return this.personConsent(res, status, id, csrf, pending, client, extra);
    const { kolabs, agents, signedIn, lastAgent, invite } = await this.kolab.consentOptions(pending.person, { inviteKey: web ? pending.inviteKey : null, clientId: pending.clientId });
    const login = extra.login ?? (await this.kolab.identities(pending.person)).find((i) => i.provider === pending.provider)?.login ?? pending.person;
    const pre = preselect(pending.scope);
    // `agent:` names an agent of theirs, or a label, as kolab login --agent takes it (<person>-<label>, API26).
    const named = pre.agent && namedAgent(pre.agent, pending.person, agents);
    // A kolab the scope names that the person can't reach (`kolab login --kolab`) is said so, with
    // the setup page's hint, and no other kolab is chosen in its place (D106).
    // Only a name a kolab can have is repeated on the page; anything else is said to be one they can't reach.
    const unreached = !invite && pre.kolab && !kolabs.some((k) => k.id === pre.kolab)
      ? (isKolabName(pre.kolab) && pre.kolab.length <= 100
        ? { kolab: pre.kolab, ...(await this.kolab.kolabHint(pending.person, pre.kolab)) }
        : { meant: '', yours: '' })
      : undefined;
    // An invite the person opened is what they came for: offered first (W3.4). Someone new, with no
    // kolab and no invite, makes their first kolab here, named after them if that name is free to try.
    const pick = extra.pick ?? {
      kolab: invite ? undefined : unreached ? '' : pre.kolab ? `kolab:${pre.kolab}` : undefined, role: pre.role,
      // Who the client works as, only among the person's own choices: an agent the scope names that
      // isn't a live agent of theirs is ignored, never shown and never honoured (D59). Never
      // Yourself: no client preselects the person, who chooses that by hand (D60). Without one named,
      // the agent this client was last granted, signing in again, unless the person revoked that
      // grant or the agent is signed in through another client now; otherwise a new agent, never
      // one of theirs signed in elsewhere, whose session choosing it would end (ENF4).
      as: web ? undefined : named && agents.includes(named) ? `agent:${named}` : lastAgent ? `agent:${lastAgent}` : 'new-agent',
      newName: !invite && !kolabs.length && isKolabName(pending.person) && pending.person.length <= 40 && !isReservedKolabName(pending.person) ? pending.person : undefined,
    };
    // The form leads on to the client's redirect URI, Allow and Deny alike, so the page's
    // form-action names it: a browser holds the 303 there to it too.
    const target = formActionSource(pending.redirectUri);
    // A scope naming the agent, kolab and role together locks the page to them (D97).
    const locked = web ? undefined : scopeLock(pending.scope, (a) => namedAgent(a, pending.person!, agents));
    const view: ConsentView = {
      signIn: id, csrf, client: client?.name ?? 'An app', wording: web ? 'kolab' : oauthWording(client?.name), redirect: redirectShown(pending.redirectUri), web, konjirAdmin: !web && await this.kolab.isAdmin(pending.person), person: pending.person, login, provider: this.labelOf(pending.provider), created: !!extra.created,
      kolabs, agents: web ? [] : agents, signedIn: web ? [] : signedIn, pick, error: extra.error, invite,
      ...(locked ? { lock: { ...locked, step: pending.step } } : {}),
      ...(unreached ? { unreached: { ...('kolab' in unreached ? { kolab: unreached.kolab } : {}), meant: unreached.meant, yours: unreached.yours } } : {}),
    };
    sendPage(res, status, view.lock ? lockedTitle(view.lock, lockAllowed(view)) : 'Sign in', consentPage(view), { formTargets: target ? [target] : [] });
  }

  /**
   * Why a setup (setupScope) can't be allowed, or undefined when it can: a scope that names it
   * badly, a client that isn't on the person's own machine (a setup is only for kolab connect and
   * its like: every redirect URI loopback), or what setupPlan refuses. With the plan, for the page.
   */
  private async setupCheck(person: string, scope: string | null, client: { redirectUris: string[] } | undefined) {
    const setup = setupScope(scope);
    if (!setup) return { refused: 'this sign-in isn\'t a setup' };
    if ('error' in setup) return { refused: `the app asked for a setup Kolab can't do: ${setup.error}. Run konjir connect again` };
    if (!client || !client.redirectUris.every(onLoopback)) return { refused: 'a setup is only for an app on your own computer, such as konjir connect, and this one receives its answer elsewhere' };
    const plan = await this.kolab.setupPlan(person, setup);
    return { plan, refused: plan.refused, forApp: plan.refusedForApp ?? plan.refused };
  }

  /** The setup page (kolab connect): locked to what the app asked, Allow or Deny; or why it can't be allowed, with Deny alone. */
  private async setupConsent(res: Response, status: number, id: string, csrf: string, pending: NonNullable<Awaited<ReturnType<Kolab['pendingAuthorization']>>>,
    client: { name: string; redirectUris: string[] } | undefined, extra: { login?: string; created?: boolean; error?: string }) {
    const person = pending.person!;
    const login = extra.login ?? (await this.kolab.identities(person)).find((i) => i.provider === pending.provider)?.login ?? person;
    const check = await this.setupCheck(person, pending.scope, client);
    const view: SetupView = {
      signIn: id, csrf, client: client?.name ?? 'An app', wording: oauthWording(client?.name), redirect: redirectShown(pending.redirectUri), person, login, provider: this.labelOf(pending.provider), created: !!extra.created,
      plan: check.plan, refused: extra.error ?? check.refused,
    };
    const target = formActionSource(pending.redirectUri);
    sendPage(res, status, view.refused ? 'Setup can\'t be allowed' : 'Set up Konjir', setupPage(view), { formTargets: target ? [target] : [] });
  }

  /**
   * Why a person's own sign-in that leaves its kolab to the page (personScope) can't be allowed, or
   * nothing when it can: a scope that names it badly, a client that isn't on the person's own device
   * (onPersonsDevice: every redirect URI loopback, as setup's, or every one konnect's own app's), or,
   * for `team:<name>`, what teamPlan refuses. With the scope, and a team's plan, for the page.
   */
  private async personCheck(person: string, scope: string | null, client: { redirectUris: string[] } | undefined): Promise<{ refused?: string; scope?: { choose: true } | { team: string; intent?: TeamIntent }; plan?: TeamPlan }> {
    const asked = personScope(scope);
    if (!asked) return { refused: 'this sign-in doesn\'t leave its kolab to this page' };
    if ('error' in asked) return { refused: `the app asked for a sign-in Kolab can't do: ${asked.error}. Start it again` };
    if (!client || !onPersonsDevice(client.redirectUris, this.kolab.appRedirects.devSchemes)) return { refused: 'a sign-in that leaves its kolab to this page is only for an app on your own computer or phone, such as konnect, and this one receives its answer elsewhere' };
    if ('choose' in asked) return { scope: asked };
    const plan = await this.kolab.teamPlan(person, asked.team, asked.intent);
    return { scope: asked, plan, ...(plan.kind === 'refused' ? { refused: plan.refusedForApp } : {}) };
  }

  /** The page of a sign-in that leaves its kolab to it: the choice of kolab or invitation (`choose:kolab`), or the one kolab to make or switch to (`team:<name>`). */
  private async personConsent(res: Response, status: number, id: string, csrf: string, pending: NonNullable<Awaited<ReturnType<Kolab['pendingAuthorization']>>>,
    client: { name: string; redirectUris: string[] } | undefined, extra: { login?: string; created?: boolean; error?: string; note?: string }) {
    const person = pending.person!;
    const login = extra.login ?? (await this.kolab.identities(person)).find((i) => i.provider === pending.provider)?.login ?? person;
    const check = await this.personCheck(person, pending.scope, client);
    const base = {
      signIn: id, csrf, client: client?.name ?? 'An app', redirect: redirectShown(pending.redirectUri), native: this.kolab.appRedirect(pending.redirectUri), person, login, provider: this.labelOf(pending.provider),
      invitable: !!this.providerOf(pending.provider)?.lookup, created: !!extra.created,
      konjirAdmin: await this.kolab.isAdmin(person), error: extra.error,
    };
    const target = formActionSource(pending.redirectUri);
    const opts = { formTargets: target ? [target] : [] };
    if (check.scope && 'team' in check.scope) {
      const view: TeamView = { ...base, plan: check.plan, intent: check.scope.intent, refused: check.plan?.kind === 'refused' ? undefined : check.refused };
      return sendPage(res, status, check.refused ? 'Sign-in can\'t be allowed' : check.plan?.kind === 'make' ? `Make ${check.scope.team}` : `Sign in to ${check.scope.team}`, teamPage(view), opts);
    }
    const options = check.refused ? { invitations: [], kolabs: [] } : await this.kolab.chooseOptions(person);
    const view: ChooseView = { ...base, ...options, refused: check.refused, note: extra.note };
    sendPage(res, status, check.refused ? 'Sign-in can\'t be allowed' : 'Choose where to sign in', choosePage(view), opts);
  }

  /**
   * The person's answer on a sign-in page that leaves its kolab to it (personConsent): a button's
   * `pick` on the choose page (`kolab:<name>`, `accept:<id>` or `decline:<id>`, which declines and
   * shows the page again), or `decision` allow with the page's `shown` on the team page; anything
   * else denies it, and a sign-in that can't be allowed tells the app why.
   */
  private async personConsented(res: Response, base: string, str: (k: string) => string, s: { id: string; binding: string; csrf: string; person: string; scope: string | null; clientId: string; provider: string }) {
    const { id, binding, csrf, person } = s;
    const check = await this.personCheck(person, s.scope, await this.client(s.clientId, ''));
    const pick = str('pick');
    // konnect's app's own page (signInApp) answers Continue or another account here, and nothing else does.
    if (!check.refused && (pick === 'continue' || pick === 'other-account')
        && await this.appChoose(await this.kolab.pendingAuthorization(binding, { csrf }))
        && await this.appAnswered(res, base, { id, binding, csrf, person, provider: s.provider }, pick)) return;
    const allowing = !check.refused && (check.scope && 'choose' in check.scope ? !!pick : str('decision') === 'allow');
    if (!allowing) {
      if (!check.refused && str('decision') !== 'deny' && (pick || str('decision'))) {
        return this.consent(res, 400, id, binding, csrf, { error: 'Choose a kolab or an invitation, or deny it.' });
      }
      // A page with nothing on it to choose says so to the app, which can say what to do next.
      const empty = !check.refused && check.scope && 'choose' in check.scope
        && Object.values(await this.kolab.chooseOptions(person)).every((l) => !l.length);
      const r = await this.kolab.declineAuthorization(binding, csrf);
      if (!r) return this.stopped(res, { binding }, id);
      clearBinding(res, this.options, id);
      const why = check.refused ? `the sign-in can't be allowed: ${check.refused}` : empty ? nothingToChoose(this.providerOf(s.provider)) : 'the person declined';
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: why, state: r.clientState ?? undefined, iss: base }));
    }
    let choice: Parameters<Kolab['consentPerson']>[2];
    if (check.scope && 'team' in check.scope) choice = { team: check.scope.team, shown: str('shown') };
    else if (pick.startsWith('decline:')) {
      try {
        const r = await this.kolab.declineInvitation(person, pick.slice('decline:'.length));
        return this.consent(res, 200, id, binding, csrf, { note: `You declined the invitation to ${r.kolab}.` });
      } catch (e) {
        if (e instanceof TenancyError) return this.consent(res, 400, id, binding, csrf, { error: maskTokens(e) });
        throw e;
      }
    } else if (pick.startsWith('accept:')) choice = { accept: pick.slice('accept:'.length) };
    else if (pick.startsWith('kolab:')) choice = { kolab: pick.slice('kolab:'.length) };
    else return this.consent(res, 400, id, binding, csrf, { error: 'Choose a kolab or an invitation, or deny it.' });
    try {
      const r = await this.kolab.consentPerson(binding, csrf, choice);
      clearBinding(res, this.options, id);
      return res.redirect(303, withParams(r.redirectUri, { code: r.code, state: r.clientState ?? undefined, iss: base }));
    } catch (e) {
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message);
      if (e instanceof AccessError || e instanceof ActorError || e instanceof TenancyError || e instanceof RoleError) {
        return this.consent(res, 400, id, binding, csrf, { error: maskTokens(e) });
      }
      throw e;
    }
  }

  /** The person's choice, from the consent page's form: same origin only, with the form's token and the browser's binding. */
  @Post('oauth/consent')
  async consented(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base || !this.idps.length) return sendError(res, 404, 'No such sign-in.');
    if (req.headers.origin !== base) return sendError(res, 403, 'A sign-in must be confirmed from Kolab\'s own page.');
    if (!this.consents.take(clientAddress(req, this.options))) return sendError(res, 429, 'Too many sign-ins just now; try again in a minute.');
    const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : '');
    const csrf = str('csrf');
    const id = str('sign_in');
    if (!csrf || !SIGN_IN_ID.test(id)) return sendError(res, 400, 'The consent form arrived without its sign-in. Start again from the app you were connecting.');
    // The form names its sign-in, whose cookie holds the binding: the form's token and the binding must be one sign-in's.
    const binding = cookieOf(req, bindingCookie(this.options, id));
    if (!binding) return this.stopped(res, { csrf });
    const pending = await this.kolab.pendingAuthorization(binding, { csrf });
    // konnect's app's *Use a different account* pressed again, before the provider answered the
    // first press: its form still names this sign-in, which names no one yet, so it asks again.
    if (pending && !pending.person && str('pick') === 'other-account' && await this.appChoose(pending)
      && await this.appAnswered(res, base, { id, binding, csrf, person: '', provider: pending.provider }, 'other-account')) return;
    if (!pending?.person) return this.stopped(res, { binding }, id);
    const setup = pending.clientId !== WEB_CLIENT && !!setupScope(pending.scope);
    // A sign-in that leaves its kolab to its own page answers there, and nowhere else.
    if (!setup && pending.clientId !== WEB_CLIENT && personScope(pending.scope)) {
      return this.personConsented(res, base, str, { id, binding, csrf, person: pending.person, scope: pending.scope, clientId: pending.clientId, provider: pending.provider });
    }
    const wording = await this.wordingOf(pending.clientId);
    if (str('decision') !== 'allow') {
      // A setup denied because it can't be allowed: the app is told why, so kolab connect can say it,
      // in the app's wording (published konnect reads `konjir connect` in it).
      // Without the person's list of kolabs, which only their own page shows: this goes to the app's redirect URI.
      const check = setup ? await this.setupCheck(pending.person, pending.scope, await this.client(pending.clientId, '')) : undefined;
      const forApp = check && ('forApp' in check ? check.forApp : check.refused);
      const why = forApp && worded(forApp, wording);
      const r = await this.kolab.declineAuthorization(binding, csrf);
      if (!r) return this.stopped(res, { binding }, id);
      clearBinding(res, this.options, id);
      // Declining drops the invite too, so no later sign-in in this browser offers it (W3.4).
      if (pending.inviteKey) clearInviteCookie(res, this.options);
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: why ? `the setup can't be allowed: ${why}` : 'the person declined', state: r.clientState ?? undefined, iss: base }));
    }
    if (setup) {
      // Nothing posted changes a setup: the scope names it all.
      try {
        // Bound to what the page showed (setupDigest): a setup that changed since is refused.
        const r = await this.kolab.consentSetup(binding, csrf, str('shown'));
        clearBinding(res, this.options, id);
        return res.redirect(303, withParams(r.redirectUri, { code: r.code, state: r.clientState ?? undefined, iss: base }));
      } catch (e) {
        if (e instanceof OAuthGrantError) return sendError(res, 400, e.message, wording);
        if (e instanceof AccessError || e instanceof ActorError || e instanceof TenancyError || e instanceof RoleError) {
          return this.consent(res, 400, id, binding, csrf, { error: maskTokens(e) });
        }
        throw e;
      }
    }
    // A form with no `as` is the web interface's (which works only as the person) or a hand-made one:
    // it never defaults to the person for an MCP client, only to a new agent of theirs.
    const asField = str('as') || (pending.clientId === WEB_CLIENT ? 'self' : 'new-agent');
    const role = str('role') as Role;
    const kolabField = str('kolab');
    const pick = { kolab: kolabField, role, as: asField, label: str('agent_label'), newName: str('new_kolab_name'), newTitle: str('new_kolab_title') };
    // The kolab field is `kolab:<name>`, `@new` or `@invite`: a kolab may be called anything a name allows.
    if (!kolabField) return this.consent(res, 400, id, binding, csrf, { error: 'Choose the kolab to work in.', pick });
    const choice: ConsentChoice = {
      as: asField === 'self' ? { kind: 'self' } : asField === 'new-agent' ? { kind: 'new-agent', label: pick.label } : { kind: 'agent', agent: asField.replace(/^agent:/, '') },
      kolab: kolabField === '@new' ? { name: pick.newName, title: pick.newTitle || pick.newName } : kolabField === '@invite' ? { invite: true }
        : kolabField.startsWith('kolab:') ? kolabField.slice('kolab:'.length) : '',
      role,
    };
    try {
      const r = await this.kolab.consent(binding, csrf, choice, { selfOnly: pending.clientId === WEB_CLIENT });
      clearBinding(res, this.options, id);
      if (pending.inviteKey) clearInviteCookie(res, this.options);
      res.redirect(303, withParams(r.redirectUri, { code: r.code, state: r.clientState ?? undefined, iss: base }));
    } catch (e) {
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message, wording);
      if (e instanceof AccessError || e instanceof ActorError || e instanceof TenancyError || e instanceof RoleError) {
        return this.consent(res, 400, id, binding, csrf, { error: maskTokens(e), pick });
      }
      throw e;
    }
  }

  // ---- tokens ------------------------------------------------------------------

  @Post('oauth/token')
  async token(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    cors(res);
    if (!originOf(req, this.options) || !this.idps.length) return json(res, 404, { error: 'not_found' });
    const str = (k: string) => (typeof body?.[k] === 'string' ? body[k] as string : undefined);
    const clientId = str('client_id');
    if (!clientId || clientId === WEB_CLIENT || !(clientId.startsWith('kjcl_') && await this.kolab.oauthClient(clientId, { use: true }))) {
      return oauthError(res, 401, 'invalid_client', 'unknown client: register it first');
    }
    try {
      const grant = str('grant_type');
      let t;
      if (grant === 'authorization_code') {
        const code = str('code'); const redirectUri = str('redirect_uri'); const verifier = str('code_verifier');
        if (!code || !redirectUri || !verifier) return oauthError(res, 400, 'invalid_request', 'send code, redirect_uri and code_verifier');
        // A setup's code (kolab connect) is exchanged for its setup token alone: no refresh token, no session.
        const setup = await this.kolab.exchangeSetupCode({ code, clientId, redirectUri, codeVerifier: verifier, resource: str('resource') });
        if (setup) return json(res, 200, { access_token: setup.accessToken, token_type: 'Bearer', expires_in: setup.expiresIn, scope: setup.scope });
        t = await this.kolab.exchangeCode({ code, clientId, redirectUri, codeVerifier: verifier, resource: str('resource') });
      } else if (grant === 'refresh_token') {
        const refresh = str('refresh_token');
        if (!refresh) return oauthError(res, 400, 'invalid_request', 'send refresh_token');
        t = await this.kolab.refreshGrant({ refreshToken: refresh, clientId });
      } else {
        return oauthError(res, 400, 'unsupported_grant_type', 'the grant types are authorization_code and refresh_token');
      }
      json(res, 200, { access_token: t.accessToken, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refreshToken, scope: t.scope });
    } catch (e) {
      if (e instanceof OAuthGrantError) return oauthError(res, 400, e.code === 'access_denied' ? 'invalid_grant' : e.code, e.message);
      throw e;
    }
  }

  /**
   * A setup token's one use (kolab connect, Lee's instruction of 2026-11-01): `Authorization:
   * Bearer <setup token>`, and the client it was issued to, `client_id`. With `mint` (the default),
   * Kolab issues each agent the person allowed on the setup's page its own grant and refresh token,
   * to that client, as that agent's own sign-in would; with `mint: false`, it only says what was set
   * up. The token is used up either way. No CORS: it is for a program on the person's machine,
   * never a web page. Nothing else reaches it: not a session token, not an ordinary sign-in's.
   */
  @Post('oauth/setup')
  async useSetup(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    if (!originOf(req, this.options) || !this.idps.length) return json(res, 404, { error: 'not_found' });
    if (!this.setupUses.take(clientAddress(req, this.options))) return oauthError(res, 429, 'temporarily_unavailable', 'too many setups from here just now; try again in a minute');
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const clientId = typeof body?.client_id === 'string' ? body.client_id : '';
    if (!token || !clientId) return oauthError(res, 400, 'invalid_request', 'send the setup token as a bearer token, and the client_id it was issued to');
    // An error is said in the wording of the client named (wording.ts): published konnect reads `konjir connect` in it.
    const say = async (text: string) => worded(text, await this.wordingOf(clientId));
    try {
      const r = await this.kolab.useSetup(token, clientId, { mint: body.mint !== false });
      json(res, 200, {
        person: r.person, kolab: r.kolab,
        agents: r.agents.map((a) => ({
          label: a.label, agent: a.agent, role: a.role, made: a.made,
          ...(a.tokens ? { access_token: a.tokens.accessToken, token_type: 'Bearer', expires_in: a.tokens.expiresIn, refresh_token: a.tokens.refreshToken, scope: a.tokens.scope } : {}),
        })),
      });
    } catch (e) {
      if (e instanceof OAuthGrantError) return oauthError(res, 400, e.code === 'access_denied' ? 'invalid_grant' : e.code, await say(e.message));
      if (e instanceof AccessError) return oauthError(res, 403, 'access_denied', await say(e.message));
      throw e;
    }
  }

  @Post('oauth/revoke')
  @HttpCode(200)
  async revoke(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    cors(res);
    if (!originOf(req, this.options) || !this.idps.length) return json(res, 404, { error: 'not_found' });
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (!token) return oauthError(res, 400, 'invalid_request', 'send the token to revoke');
    // RFC 7009 §2.1: only a token issued to the client asking. A public client names itself; the
    // web interface's own sign-out revokes its token in the process, never here.
    const clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
    if (!clientId || clientId === WEB_CLIENT || !(clientId.startsWith('kjcl_') && await this.kolab.oauthClient(clientId))) {
      return oauthError(res, 401, 'invalid_client', 'name the registered client the token was issued to');
    }
    // RFC 7009 §2.2: the answer is the same whether or not the token was valid.
    await this.kolab.revokeToken(token, { clientId }).catch((e) => {
      this.logger.warn(`could not revoke a token: ${maskTokens(e)}`);
    });
    json(res, 200, {});
  }
}

/** Whether a redirect URI is on this machine: http on 127.0.0.1 or [::1], any port, as kolab's own are. */
export function onLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  } catch { return false; }
}

/** Clears one sign-in's binding cookie, and no other's. */
function clearBinding(res: Response, options: OAuthOptions, id: string) {
  res.append('set-cookie', `${bindingCookie(options, id)}=; ${bindingCookieAttrs(options, '/oauth')}; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** A redirect URI as the consent page shows it: its origin, or for an app's own scheme, the URI. */
function redirectShown(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : uri;
  } catch { return uri; }
}

/** A redirect URI with these parameters added (undefined ones left out); its own query kept. */
export function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** Constant-time equality of two strings. */
export function sameSecret(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
