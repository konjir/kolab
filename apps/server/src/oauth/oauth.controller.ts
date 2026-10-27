import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Logger, Options, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessError, ActorError, Kolab, OAuthGrantError, RoleError, TenancyError, isReservedKolabName, maskTokens, redirectUriMatches, scopeLock, signInStep, type ConsentChoice } from '@konjir/engine';
import { isKolabName } from '@konjir/address';
import { ADMIN_ELEVATION_S, ROLES, type Role } from '@konjir/types';
import { MCP_ROUTE, OAUTH_OPTIONS, KOLAB, type OAuthOptions } from '../tokens.js';
import { consentPage, formActionSource, lockAllowed, lockedTitle, raisedPage, raisePage, sendError, sendPage, type ConsentView } from './pages.js';

/** The web interface's own client: first party, never registered, and only ever a person (W3.1). */
export const WEB_CLIENT = 'konjir-web';
/** Where the web interface receives its code. */
export const WEB_CALLBACK = '/api/session/oauth/callback';
/**
 * Kolab's own sign-in that completes an admin raise (W2.22): first party, never registered, issues
 * no code, and /oauth/authorize never starts it; only /oauth/raise does.
 */
export const RAISE_CLIENT = 'konjir-raise';
const RAISE_GONE = 'This raise link is unknown, used or expired, or the session it was for has ended. Ask for a new one from your app with konjir admin_elevate.';

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

/** The PKCE verifier of Kolab's own request to the identity provider: derived from the binding, which only the browser holds. */
const providerVerifier = (binding: string) => createHash('sha256').update(`konjir-idp:${binding}`).digest('base64url');
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url');

/** How long a sign-in lasts, in words. */
const lasting = (ttlS: number) => (ttlS % 60 ? `${ttlS} seconds` : `${ttlS / 60} minutes`);
/** What the person is told when a sign-in can't go on, by what became of it (Kolab.signInStatus). */
const EXPIRED = (ttlS: number) => `This sign-in expired: it lasts ${lasting(ttlS)} from when the app opened it. Start again from the app you were connecting.`;
const USED = 'This sign-in was already used: it was allowed, denied or cancelled. If the app you were connecting isn\'t signed in, start again from there.';
const NOT_HERE = `This sign-in didn't start in this browser, or the browser let it go: it holds ${OPEN_SIGN_INS} sign-ins at most, and newer ones took its place. Finish it in the browser the app opened, or start again from the app you were connecting.`;

/**
 * At most `perKey` calls in `windowMs` for any one key (a client address), and at most `total` in
 * all, per process: one caller can't use up everyone's budget, and the total is a backstop. All
 * are checked before any is taken, so a refused call spends nothing. Keys idle for a window are
 * forgotten.
 */
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

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(OAUTH_OPTIONS) private readonly options: OAuthOptions,
  ) {}

  private get idp() { return this.options.identity; }

  // ---- metadata ---------------------------------------------------------------

  @Get(['.well-known/oauth-protected-resource', `.well-known/oauth-protected-resource/${MCP_ROUTE}`])
  protectedResource(@Req() req: Request, @Res() res: Response) {
    cors(res);
    const base = originOf(req, this.options);
    if (!base || !this.idp) return json(res, 404, { error: 'not_found' });
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
    if (!base || !this.idp) return json(res, 404, { error: 'not_found' });
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
    if (!originOf(req, this.options) || !this.idp) return json(res, 404, { error: 'not_found' });
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

  @Get('oauth/authorize')
  async authorize(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base) return sendError(res, 403, 'This Kolab doesn\'t serve that host.');
    if (!this.idp) return sendError(res, 404, 'Signing in with an identity provider isn\'t set up on this Kolab.');
    const str = (k: string) => (typeof q[k] === 'string' ? q[k] as string : undefined);
    const clientId = str('client_id');
    const redirectUri = str('redirect_uri');
    // Nothing is redirected anywhere before the person has seen the consent page: not until the
    // client and its redirect URI check out (RFC 6749 §4.1.2.1), and not for an error after that
    // either, since anyone can register a client with any https redirect URI (RFC 9700 §4.11.2).
    // Each error is a page that says what went wrong.
    const client = clientId ? await this.client(clientId, base, true) : undefined;
    if (!client) return sendError(res, 400, 'The app asked to sign in as a client this Kolab doesn\'t know. Reconnect it to register again.');
    if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) return sendError(res, 400, 'The app asked for its answer at an address it didn\'t register, so Kolab won\'t send it there.');
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
    // Only the web interface's own sign-in carries an invite (W3.4), from the cookie its page set.
    const invite = client.web ? cookieOf(req, inviteCookie(this.options)) : undefined;
    await this.toIdentityProvider(req, res, base, {
      clientId: clientId!, redirectUri, clientState: state, codeChallenge: challenge, scope: str('scope'), resource, invite,
      // Which of several sign-ins this is (`konjir connect`'s "agent N of M"): display only, kept
      // only when both are whole numbers, never part of the scope, so it grants nothing. Only from
      // an app on the person's own machine (every redirect URI loopback, as konjir's are): from a
      // hosted one it would dress a lure up as a setup the person started, so it is ignored (D97).
      step: client.web || !client.redirectUris.every(onLoopback) ? null : signInStep(q.step, q.steps),
    });
  }

  /**
   * Starts a sign-in in this browser and sends it to the identity provider: a binding cookie of its
   * own, and the provider's state naming it (D57). At the cap, the oldest sign-ins in this browser
   * are let go, so this one has room. `fresh` asks the provider to have the person choose their
   * account by hand (an admin raise).
   */
  private async toIdentityProvider(req: Request, res: Response, base: string,
    r: Omit<Parameters<Kolab['beginAuthorization']>[0], 'provider'>, opts: { fresh?: boolean } = {}) {
    const held = bindingsOf(req, this.options);
    const evict: string[] = [];
    if (held.length >= OPEN_SIGN_INS) {
      const oldest = await this.kolab.signInsByAge(held.map((h) => h.binding));
      const drop = new Set(oldest.slice(0, held.length - OPEN_SIGN_INS + 1));
      for (const h of held) if (drop.has(h.binding)) evict.push(h.id);
    }
    const { binding, state: idpState } = await this.kolab.beginAuthorization({ provider: this.idp!.id, ...r });
    const id = randomBytes(8).toString('base64url');
    for (const old of evict) clearBinding(res, this.options, old);
    res.append('set-cookie', `${bindingCookie(this.options, id)}=${binding}; ${bindingCookieAttrs(this.options, '/oauth')}; HttpOnly; SameSite=Lax; Max-Age=${this.kolab.oauth.requestTtlS}`);
    res.setHeader('referrer-policy', 'no-referrer');
    res.redirect(302, this.idp!.authorizationUrl({
      redirectUri: `${base}/oauth/callback/${this.idp!.id}`, state: `${id}.${idpState}`, codeChallenge: s256(providerVerifier(binding)), ...(opts.fresh ? { fresh: true } : {}),
    }));
  }

  /**
   * The link konjir_admin_elevate answers with (W2.22, Lee's ruling of 2026-10-23): the only way a
   * session is raised. The person opens it in their browser and signs in with the identity provider
   * (GitHub's account picker: GitHub has no forced re-authentication, so this is not a password or
   * 2FA check), through a sign-in of Kolab's own with every protection of any other (its binding cookie,
   * the provider's state, the consent form's token and Kolab's own origin, D55, D57), and, as the
   * session's own person, confirms on Kolab's page. It is limited like an authorization.
   */
  @Get('oauth/raise')
  async raise(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base) return sendError(res, 403, 'This Kolab doesn\'t serve that host.');
    if (!this.idp) return sendError(res, 404, 'Signing in with an identity provider isn\'t set up on this Kolab.');
    if (!this.authorizations.take(clientAddress(req, this.options))) return sendError(res, 429, 'Too many sign-ins just now; try again in a minute.');
    const request = typeof q.request === 'string' ? q.request : '';
    if (!(await this.kolab.pendingRaise(request))) return sendError(res, 400, RAISE_GONE);
    // Kolab's own sign-in: no client's redirect URI and no client's PKCE, so neither is anyone's to use.
    await this.toIdentityProvider(req, res, base, {
      clientId: RAISE_CLIENT, redirectUri: `${base}/oauth/raise`, codeChallenge: s256(randomBytes(32).toString('base64url')), raise: request,
    }, { fresh: true });
  }

  /**
   * The identity provider's answer for a raise's sign-in: only the raise's own person goes on, to
   * the page that confirms it. Nobody is signed up here; anyone else is stopped, and the sign-in
   * with them, and the request is used up: a link that reached someone else is never good again.
   */
  private async raiseSignedIn(res: Response, id: string, binding: string, state: string, raiseKey: string, who: { subject: string; login: string }) {
    const raise = await this.kolab.pendingRaiseByKey(raiseKey);
    const person = await this.kolab.personOf({ provider: this.idp!.id, subject: who.subject });
    if (!raise || !person || person !== raise.actor) {
      await this.kolab.abandonAuthorization(binding, state);
      clearBinding(res, this.options, id);
      if (!raise) return sendError(res, 400, RAISE_GONE);
      return sendError(res, 403, `This raise is for ${raise.actor}'s session, and only ${raise.actor} can confirm it. You signed in with ${this.idp!.label} as ${who.login}${person ? `, who is ${person} here` : ', who isn\'t anyone in Kolab'}. Nothing was raised, and the link is used up.`);
    }
    let csrf: string;
    try {
      ({ csrf } = await this.kolab.identifyAuthorization(binding, state, person));
    } catch (e) {
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message);
      throw e;
    }
    sendPage(res, 200, 'Raise your session', raisePage({
      signIn: id, csrf, person, login: who.login, provider: this.idp!.label, session: raise.session, sessionStarted: raise.sessionStarted,
      client: raise.client, expiresAt: raise.expiresAt, minutes: ADMIN_ELEVATION_S / 60,
    }));
  }

  /** The identity provider's answer: who signed in. Then the consent page. */
  @Get('oauth/callback/:provider')
  async callback(@Req() req: Request, @Res() res: Response, @Param('provider') provider: string, @Query() q: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base || !this.idp || provider !== this.idp.id) return sendError(res, 404, 'No such sign-in.');
    if (!this.callbacks.take(clientAddress(req, this.options))) return sendError(res, 429, 'Too many sign-ins just now; try again in a minute.');
    // The provider's state is `<id>.<state>`: the sign-in's id names its cookie.
    const full = typeof q.state === 'string' ? q.state : '';
    const dot = full.indexOf('.');
    const id = dot < 0 ? '' : full.slice(0, dot);
    const state = dot < 0 ? '' : full.slice(dot + 1);
    if (!SIGN_IN_ID.test(id) || !state) return sendError(res, 400, `${this.idp.label}'s answer doesn't name a sign-in of Kolab's. Start again from the app you were connecting.`);
    const binding = cookieOf(req, bindingCookie(this.options, id));
    if (!binding) return this.stopped(res, { state });
    if (typeof q.error === 'string' || typeof q.code !== 'string') {
      const r = await this.kolab.abandonAuthorization(binding, state);
      if (!r) return this.stopped(res, { binding }, id);
      // Cancelled: the sign-in is over, and its cookie goes with it.
      clearBinding(res, this.options, id);
      // A raise's sign-in has no client to tell (W2.22): it says so here.
      if (r.redirectUri === `${base}/oauth/raise`) return sendPage(res, 200, 'Not raised', raisedPage({ person: '' }));
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: `the sign-in with ${this.idp.label} was cancelled`, state: r.clientState ?? undefined, iss: base }));
    }
    // The binding and the state together, before the code goes anywhere (RFC 6749 §10.12).
    const pending = await this.kolab.pendingAuthorization(binding, { state });
    if (!pending) return this.stopped(res, { binding }, id);
    // The provider's answer came back a second time (the page reloaded, say): it counts once.
    if (pending.person) return sendError(res, 400, `${this.idp.label}'s answer for this sign-in was already used. Go back to the consent page it showed, or start again from the app you were connecting.`);
    let who;
    try {
      who = await this.idp.identify({ code: q.code, redirectUri: `${base}/oauth/callback/${this.idp.id}`, codeVerifier: providerVerifier(binding) });
    } catch (e) {
      this.logger.warn(`a sign-in with ${this.idp.label} failed: ${maskTokens(e)}`);
      return sendError(res, 502, `${this.idp.label} didn't confirm who signed in. Try again.`);
    }
    // An admin raise's sign-in (W2.22) goes only to its own confirmation, never to a consent.
    if (pending.raiseKey) return this.raiseSignedIn(res, id, binding, state, pending.raiseKey, who);
    let person: { actor: string; created: boolean };
    try {
      person = await this.kolab.signInWith({ provider: this.idp.id, ...who });
    } catch (e) {
      if (e instanceof ActorError) return sendError(res, 403, e.message);
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
   * A sign-in that can't go on, and why, as plainly as Kolab can tell: it expired, it was used, or
   * it is still open but not in this browser. `by` is whichever of its secrets the request carried.
   * `id` names the sign-in whose cookie the request carried: one that expired or was used is over,
   * and its cookie is cleared, so it holds no place under the cap.
   */
  private async stopped(res: Response, by: Parameters<Kolab['signInStatus']>[0], id?: string) {
    const status = await this.kolab.signInStatus(by);
    if (id && status !== 'open') clearBinding(res, this.options, id);
    return sendError(res, 400, status === 'expired' ? EXPIRED(this.kolab.oauth.requestTtlS) : status === 'open' ? NOT_HERE : USED);
  }

  private async consent(res: Response, status: number, id: string, binding: string, csrf: string, extra: { login?: string; created?: boolean; error?: string; pick?: ConsentView['pick'] }) {
    const pending = await this.kolab.pendingAuthorization(binding);
    if (!pending?.person) return this.stopped(res, { binding }, id);
    const client = await this.client(pending.clientId, '');
    const web = pending.clientId === WEB_CLIENT;
    const { kolabs, agents, signedIn, lastAgent, invite } = await this.kolab.consentOptions(pending.person, { inviteKey: web ? pending.inviteKey : null, clientId: pending.clientId });
    const login = extra.login ?? (await this.kolab.identities(pending.person)).find((i) => i.provider === pending.provider)?.login ?? pending.person;
    const pre = preselect(pending.scope);
    // An invite the person opened is what they came for: offered first (W3.4). Someone new, with no
    // kolab and no invite, makes their first kolab here, named after them if that name is free to try.
    const pick = extra.pick ?? {
      kolab: invite ? undefined : pre.kolab && kolabs.some((k) => k.id === pre.kolab) ? `kolab:${pre.kolab}` : undefined, role: pre.role,
      // Who the client works as, only among the person's own choices: an agent the scope names that
      // isn't a live agent of theirs is ignored, never shown and never honoured (D59). Never
      // Yourself: no client preselects the person, who chooses that by hand (D60). Without one named,
      // the agent this client was last granted, signing in again, unless the person revoked that
      // grant or the agent is signed in through another client now; otherwise a new agent, never
      // one of theirs signed in elsewhere, whose session choosing it would end (ENF4).
      as: web ? undefined : pre.agent && agents.includes(pre.agent) ? `agent:${pre.agent}` : lastAgent ? `agent:${lastAgent}` : 'new-agent',
      newName: !invite && !kolabs.length && isKolabName(pending.person) && pending.person.length <= 40 && !isReservedKolabName(pending.person) ? pending.person : undefined,
    };
    // The form leads on to the client's redirect URI, Allow and Deny alike, so the page's
    // form-action names it: a browser holds the 303 there to it too.
    const target = formActionSource(pending.redirectUri);
    // A scope naming the agent, kolab and role together locks the page to them (D97).
    const locked = web ? undefined : scopeLock(pending.scope);
    const view: ConsentView = {
      signIn: id, csrf, client: client?.name ?? 'An app', redirect: redirectShown(pending.redirectUri), web, person: pending.person, login, provider: this.idp!.label, created: !!extra.created,
      kolabs, agents: web ? [] : agents, signedIn: web ? [] : signedIn, pick, error: extra.error, invite,
      ...(locked ? { lock: { ...locked, step: pending.step } } : {}),
    };
    sendPage(res, status, view.lock ? lockedTitle(view.lock, lockAllowed(view)) : 'Sign in', consentPage(view), { formTargets: target ? [target] : [] });
  }

  /** The person's choice, from the consent page's form: same origin only, with the form's token and the browser's binding. */
  @Post('oauth/consent')
  async consented(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base || !this.idp) return sendError(res, 404, 'No such sign-in.');
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
    if (!pending?.person) return this.stopped(res, { binding }, id);
    // An admin raise's confirmation (W2.22): checked as every consent form is, above, then completed here, by its own person only.
    if (pending.raiseKey) return this.raiseConfirmed(res, id, binding, csrf, str('decision') === 'allow', pending.person);
    if (str('decision') !== 'allow') {
      const r = await this.kolab.declineAuthorization(binding, csrf);
      if (!r) return this.stopped(res, { binding }, id);
      clearBinding(res, this.options, id);
      // Declining drops the invite too, so no later sign-in in this browser offers it (W3.4).
      if (pending.inviteKey) clearInviteCookie(res, this.options);
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: 'the person declined', state: r.clientState ?? undefined, iss: base }));
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
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message);
      if (e instanceof AccessError || e instanceof ActorError || e instanceof TenancyError || e instanceof RoleError) {
        return this.consent(res, 400, id, binding, csrf, { error: maskTokens(e), pick });
      }
      throw e;
    }
  }

  /** A raise confirmed or declined on its page: the sign-in is over either way, and its cookie goes. */
  private async raiseConfirmed(res: Response, id: string, binding: string, csrf: string, allow: boolean, person: string) {
    if (!allow) {
      const r = await this.kolab.declineAuthorization(binding, csrf);
      if (!r) return this.stopped(res, { binding }, id);
      clearBinding(res, this.options, id);
      return sendPage(res, 200, 'Not raised', raisedPage({ person }));
    }
    try {
      const r = await this.kolab.completeRaise(binding, csrf);
      clearBinding(res, this.options, id);
      sendPage(res, 200, 'Raised', raisedPage({ person: r.actor, until: r.until }));
    } catch (e) {
      if (e instanceof OAuthGrantError || e instanceof AccessError || e instanceof RoleError) {
        // Over: nothing was raised, and this sign-in can't raise anything now.
        await this.kolab.declineAuthorization(binding, csrf);
        clearBinding(res, this.options, id);
        return sendError(res, e instanceof OAuthGrantError ? 400 : 403, `${maskTokens(e)}. Nothing was raised.`);
      }
      throw e;
    }
  }

  // ---- tokens ------------------------------------------------------------------

  @Post('oauth/token')
  async token(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    cors(res);
    if (!originOf(req, this.options) || !this.idp) return json(res, 404, { error: 'not_found' });
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

  @Post('oauth/revoke')
  @HttpCode(200)
  async revoke(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    cors(res);
    if (!originOf(req, this.options) || !this.idp) return json(res, 404, { error: 'not_found' });
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

/** Whether a redirect URI is on this machine: http on 127.0.0.1 or [::1], any port, as konjir's own are. */
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
