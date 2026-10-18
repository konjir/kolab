import { createHash, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Logger, Options, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AccessError, ActorError, Kolab, OAuthGrantError, RoleError, TenancyError, maskTokens, redirectUriMatches, type ConsentChoice } from '@konjir/engine';
import { ROLES, type Role } from '@konjir/types';
import { MCP_ROUTE, OAUTH_OPTIONS, KOLAB, type OAuthOptions } from '../tokens.js';
import { consentPage, sendError, sendPage, type ConsentView } from './pages.js';

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
 * host under the same domain can toss one in its place; on loopback, scoped to /oauth.
 */
const bindingCookie = (options: OAuthOptions) => (options.publicHost ? '__Host-konjir_oauth' : 'konjir_oauth');
export const bindingCookieAttrs = (options: { publicHost?: string }, path: string) => (options.publicHost ? 'Path=/; Secure' : `Path=${path}`);

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

/**
 * At most `perKey` calls in `windowMs` for any one key (a client address, a client), and at most
 * `total` in all, per process: one caller can't use up everyone's budget, and the total is a
 * backstop. Keys idle for a window are forgotten.
 */
export class Limit {
  private readonly byKey = new Map<string, number[]>();
  private all: number[] = [];
  constructor(private readonly perKey: number, private readonly total: number, private readonly windowMs: number) {}
  take(...keys: string[]): boolean {
    const now = Date.now();
    const live = (ts: number[] | undefined) => (ts ?? []).filter((t) => now - t < this.windowMs);
    this.all = live(this.all);
    if (this.all.length >= this.total) return false;
    const each = keys.map((k) => live(this.byKey.get(k)));
    if (each.some((ts) => ts.length >= this.perKey)) return false;
    keys.forEach((k, i) => this.byKey.set(k, [...each[i], now]));
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
export function clientAddress(req: Request, options: { publicHost?: string }): string {
  const socket = req.socket?.remoteAddress ?? '';
  const viaProxy = !!options.publicHost && /^(127\.|::1$|::ffff:127\.)/.test(socket);
  const forwarded = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',').pop()?.trim() : undefined;
  return `ip:${viaProxy && forwarded ? forwarded : socket}`;
}

/** The scope a client asks with may name a kolab and a role to preselect: `kolab:<name> role:<role>`. */
function preselect(scope: string | null | undefined): { kolab?: string; role?: Role } {
  const words = (scope ?? '').split(/\s+/);
  const kolab = words.find((w) => w.startsWith('kolab:'))?.slice(6);
  const role = words.find((w) => w.startsWith('role:'))?.slice(5) as Role | undefined;
  return { kolab, role: role && ROLES.includes(role) ? role : undefined };
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
  /** Authorizations of a known client at a registered redirect URI: 30 a minute from one address, 60 for one client, 3000 in all. */
  private readonly authorizations = new Limit(30, 3000, 60_000);
  private readonly authorizationsPerClient = new Limit(60, 3000, 60_000);

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
    json(res, 200, {
      resource: `${base}/${MCP_ROUTE}`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      scopes_supported: ['konjir'],
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
    if (!this.authorizations.take(clientAddress(req, this.options)) || !this.authorizationsPerClient.take(`client:${clientId}`)) {
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
    const { binding, state: idpState } = await this.kolab.beginAuthorization({
      provider: this.idp.id, clientId: clientId!, redirectUri, clientState: state, codeChallenge: challenge, scope: str('scope'), resource,
    });
    res.setHeader('set-cookie', `${bindingCookie(this.options)}=${binding}; ${bindingCookieAttrs(this.options, '/oauth')}; HttpOnly; SameSite=Lax; Max-Age=${this.kolab.oauth.requestTtlS}`);
    res.setHeader('referrer-policy', 'no-referrer');
    res.redirect(302, this.idp.authorizationUrl({ redirectUri: `${base}/oauth/callback/${this.idp.id}`, state: idpState, codeChallenge: s256(providerVerifier(binding)) }));
  }

  /** The identity provider's answer: who signed in. Then the consent page. */
  @Get('oauth/callback/:provider')
  async callback(@Req() req: Request, @Res() res: Response, @Param('provider') provider: string, @Query() q: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base || !this.idp || provider !== this.idp.id) return sendError(res, 404, 'No such sign-in.');
    const binding = cookieOf(req, bindingCookie(this.options));
    const state = typeof q.state === 'string' ? q.state : '';
    if (!binding || !state) return sendError(res, 400, 'This sign-in didn\'t start in this browser, or took too long.');
    if (typeof q.error === 'string' || typeof q.code !== 'string') {
      const r = await this.kolab.abandonAuthorization(binding, state);
      if (!r) return sendError(res, 400, 'This sign-in didn\'t start in this browser, or took too long.');
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: `the sign-in with ${this.idp.label} was cancelled`, state: r.clientState ?? undefined, iss: base }));
    }
    // The binding and the state together, before the code goes anywhere (RFC 6749 §10.12).
    const pending = await this.kolab.pendingAuthorization(binding, { state });
    if (!pending || pending.person) return sendError(res, 400, 'This sign-in didn\'t start in this browser, was already used, or took too long.');
    let who;
    try {
      who = await this.idp.identify({ code: q.code, redirectUri: `${base}/oauth/callback/${this.idp.id}`, codeVerifier: providerVerifier(binding) });
    } catch (e) {
      this.logger.warn(`a sign-in with ${this.idp.label} failed: ${maskTokens(e)}`);
      return sendError(res, 502, `${this.idp.label} didn't confirm who signed in. Try again.`);
    }
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
    await this.consent(res, 200, binding, csrf, { login: who.login, created: person.created });
  }

  private async consent(res: Response, status: number, binding: string, csrf: string, extra: { login?: string; created?: boolean; error?: string; pick?: ConsentView['pick'] }) {
    const pending = await this.kolab.pendingAuthorization(binding);
    if (!pending?.person) return sendError(res, 400, 'This sign-in expired or was already used. Start again.');
    const client = await this.client(pending.clientId, '');
    const web = pending.clientId === WEB_CLIENT;
    const { kolabs, agents } = await this.kolab.consentOptions(pending.person);
    const login = extra.login ?? (await this.kolab.identities(pending.person)).find((i) => i.provider === pending.provider)?.login ?? pending.person;
    const pre = preselect(pending.scope);
    const pick = extra.pick ?? { kolab: pre.kolab && kolabs.some((k) => k.id === pre.kolab) ? pre.kolab : undefined, role: pre.role };
    sendPage(res, status, 'Sign in', consentPage({
      csrf, client: client?.name ?? 'An app', redirect: redirectShown(pending.redirectUri), web, person: pending.person, login, provider: this.idp!.label, created: !!extra.created,
      kolabs, agents: web ? [] : agents, pick, error: extra.error,
    }));
  }

  /** The person's choice, from the consent page's form: same origin only, with the form's token and the browser's binding. */
  @Post('oauth/consent')
  async consented(@Req() req: Request, @Res() res: Response, @Body() body: Record<string, unknown>) {
    const base = originOf(req, this.options);
    if (!base || !this.idp) return sendError(res, 404, 'No such sign-in.');
    if (req.headers.origin !== base) return sendError(res, 403, 'A sign-in must be confirmed from Kolab\'s own page.');
    const binding = cookieOf(req, bindingCookie(this.options));
    const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : '');
    const csrf = str('csrf');
    if (!binding || !csrf) return sendError(res, 400, 'This sign-in didn\'t start in this browser, or took too long.');
    const pending = await this.kolab.pendingAuthorization(binding);
    if (!pending?.person) return sendError(res, 400, 'This sign-in expired or was already used. Start again.');
    if (str('decision') !== 'allow') {
      const r = await this.kolab.declineAuthorization(binding, csrf);
      if (!r) return sendError(res, 400, 'This sign-in expired or was already used. Start again.');
      clearBinding(res, this.options);
      return res.redirect(303, withParams(r.redirectUri, { error: 'access_denied', error_description: 'the person declined', state: r.clientState ?? undefined, iss: base }));
    }
    const asField = str('as') || 'self';
    const role = str('role') as Role;
    const kolabField = str('kolab');
    const pick = { kolab: kolabField, role, as: asField, label: str('agent_label'), newName: str('new_kolab_name'), newTitle: str('new_kolab_title') };
    const choice: ConsentChoice = {
      as: asField === 'self' ? { kind: 'self' } : asField === 'new-agent' ? { kind: 'new-agent', label: pick.label } : { kind: 'agent', agent: asField.replace(/^agent:/, '') },
      kolab: kolabField === 'new' ? { name: pick.newName, title: pick.newTitle || pick.newName } : kolabField,
      role,
    };
    try {
      const r = await this.kolab.consent(binding, csrf, choice, { selfOnly: pending.clientId === WEB_CLIENT });
      clearBinding(res, this.options);
      res.redirect(303, withParams(r.redirectUri, { code: r.code, state: r.clientState ?? undefined, iss: base }));
    } catch (e) {
      if (e instanceof OAuthGrantError) return sendError(res, 400, e.message);
      if (e instanceof AccessError || e instanceof ActorError || e instanceof TenancyError || e instanceof RoleError) {
        return this.consent(res, 400, binding, csrf, { error: maskTokens(e), pick });
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

function clearBinding(res: Response, options: OAuthOptions) {
  res.append('set-cookie', `${bindingCookie(options)}=; ${bindingCookieAttrs(options, '/oauth')}; HttpOnly; SameSite=Lax; Max-Age=0`);
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
