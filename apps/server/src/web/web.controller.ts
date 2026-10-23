import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpException, Inject, Logger, NotFoundException, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Kolab, maskTokens } from '@konjir/engine';
import type {
  InvitePreview, WebAnswer, WebChangeGrant, WebAsk, WebCreateInvite, WebCreateKolab, WebCreateNode, WebInviteToken, WebMe, WebOpenCase, WebPosition, WebResolve, WebRuleCase, WebRuleDirect,
  WebCli, WebSignIn, WebSignInMethods, WebSubmit, WebSwitch, WebVerdict,
} from '@konjir/types';
import { KOLAB, WEB_OPTIONS, type WebOptions } from '../tokens.js';
import {
  Limit, WEB_CALLBACK, WEB_CLIENT, bindingCookieAttrs, clearInviteCookie, clientAddress, cookieOf, originOf, sameSecret, setInviteCookie,
} from '../oauth/oauth.controller.js';
import {
  WebPeople, WebSession, WebSessionGuard, WebWho, checkOrigin, clearSessionCookie, refreshCookieName, setSessionCookie, tokenOf,
} from './auth.js';
import { WebService, httpError } from './web.service.js';

/** Runs a call, turning Kolab's errors into the API's (WebError), with any token masked. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw httpError(e); }
}

const seqOf = new ParseIntPipe({ errorHttpStatusCode: 400 });

/** A list's page, from `?cursor=` and `?limit=` (W2.21): Kolab checks both, and caps the limit. */
function page(cursor: unknown, limit: unknown) {
  const l = one('limit', limit);
  const n = l === undefined ? undefined : Number(l);
  if (n !== undefined && !Number.isInteger(n)) throw new BadRequestException({ error: 'bad_request', message: 'limit is a whole number' });
  return { cursor: one('cursor', cursor), limit: n };
}

/** A query parameter given once, as text: a repeated one (an array to Express) is refused, never passed on. */
function one(name: string, v: unknown): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string') throw new BadRequestException({ error: 'bad_request', message: `give ${name} once` });
  return v;
}

/**
 * The cookie that carries the web interface's own PKCE verifier and state while it signs in.
 * Behind the TLS proxy it is `__Host-` (Secure, Path=/, no Domain), so no other host under the
 * same domain can toss one in to sign a person in as someone else; on loopback, only to its callback.
 */
const pkceCookie = (options: WebOptions) => (options.publicHost ? '__Host-konjir_web_oauth' : 'konjir_web_oauth');
const pkcePath = WEB_CALLBACK.slice(0, WEB_CALLBACK.lastIndexOf('/'));

/** How long the invite a person opened waits for them to sign in (W3.4): longer than a sign-in may take. */
const INVITE_COOKIE_S = 1800;

/** Signing in and out of the web interface, and switching kolab or role (see auth.ts). */
@Controller('api/session')
export class WebSessionController {
  private readonly logger = new Logger('WebSignIn');
  /**
   * Opening an invite's link, signed in or not: 30 a minute from one address (an IPv6 /64), and no
   * total, so a few addresses can't lock everyone out. An invite's secret is 256 bits, so this
   * guards the database, not the secret.
   */
  private readonly invitesOpened = new Limit(30, Infinity, 60_000);

  constructor(
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
    @Inject(WebService) private readonly web: WebService,
    @Inject(WebPeople) private readonly people: WebPeople,
    @Inject(KOLAB) private readonly kolab: Kolab,
  ) {}

  /** How a person may sign in here: with the identity provider (D55), with a pasted token (development), or both. */
  @Get('methods')
  methods(@Req() req: Request): WebSignInMethods {
    checkOrigin(req, this.options);
    return { provider: this.options.identityLabel ?? null, token: this.options.tokenSignIn };
  }

  /**
   * How to get the konjir CLI here (W3.7): the published package's pinned spec, if the operator set
   * one; otherwise none, and the page shows a checkout's bin/konjir, never an `npx` of a name
   * anyone could register.
   */
  @Get('cli')
  cli(@Req() req: Request): WebCli {
    checkOrigin(req, this.options);
    return { npm: this.options.cliNpmSpec ?? null };
  }

  /**
   * Starts signing in with the identity provider (D55): the web interface is Kolab's own OAuth
   * client, `konjir-web`, with PKCE and a state of its own, kept in a cookie only its callback reads.
   */
  @Get('oauth/start')
  start(@Req() req: Request, @Res() res: Response) {
    checkOrigin(req, this.options);
    if (!this.options.identityLabel) throw new NotFoundException({ error: 'not_found', message: 'signing in with an identity provider isn\'t set up on this Kolab' });
    const base = originOf(req, this.options)!;
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    res.setHeader('set-cookie', `${pkceCookie(this.options)}=${state}.${verifier}; ${bindingCookieAttrs(this.options, pkcePath)}; HttpOnly; SameSite=Lax; Max-Age=900`);
    const u = new URL('/oauth/authorize', base);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: WEB_CLIENT, redirect_uri: `${base}${WEB_CALLBACK}`, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    res.redirect(302, u.pathname + u.search);
  }

  /** The web interface's code comes back: exchanged here, in the process, for the person's tokens, kept in the cookies. */
  @Get('oauth/callback')
  async callback(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, unknown>) {
    checkOrigin(req, this.options);
    const base = originOf(req, this.options)!;
    const back = (error?: string) => {
      res.append('set-cookie', `${pkceCookie(this.options)}=; ${bindingCookieAttrs(this.options, pkcePath)}; HttpOnly; SameSite=Lax; Max-Age=0`);
      res.redirect(303, error ? `/?signin_error=${encodeURIComponent(error)}` : '/');
    };
    const [state, verifier] = (cookieOf(req, pkceCookie(this.options)) ?? '').split('.');
    if (!state || !verifier || typeof q.state !== 'string' || !sameSecret(state, q.state)) return back('That sign-in didn\'t start in this browser, or took too long. Try again.');
    if (q.iss !== undefined && q.iss !== base) return back('That sign-in came back from another server. Try again.');
    if (typeof q.code !== 'string') return back(q.error === 'access_denied' ? 'Signing in was cancelled.' : 'Signing in didn\'t finish. Try again.');
    try {
      const t = await this.kolab.exchangeCode({ code: q.code, clientId: WEB_CLIENT, redirectUri: `${base}${WEB_CALLBACK}`, codeVerifier: verifier });
      await this.people.check(t.accessToken);
      setSessionCookie(res, t.accessToken, this.options, t.refreshToken);
      back();
    } catch (e) {
      this.logger.warn(`a web sign-in failed: ${maskTokens(e)}`);
      back('Signing in didn\'t finish. Try again.');
    }
  }

  /** With token sign-in on (development): checks the token is a person's open session, and keeps it in the page's cookie. */
  @Post()
  @HttpCode(200)
  async signIn(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: WebSignIn): Promise<WebMe> {
    checkOrigin(req, this.options);
    if (!this.options.tokenSignIn) {
      throw new ForbiddenException({ error: 'forbidden', message: `signing in with a token is turned off here: sign in${this.options.identityLabel ? ` with ${this.options.identityLabel}` : ''}` });
    }
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const me = await run(() => this.people.check(token || undefined));
    setSessionCookie(res, token, this.options);
    return me;
  }

  /**
   * Signs out: a person's session ends, so its token is revoked everywhere, and so does the grant
   * its refresh token renews (D55); the cookies are cleared.
   */
  @Delete()
  @HttpCode(204)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    checkOrigin(req, this.options);
    const token = tokenOf(req, this.options);
    const refresh = tokenOf(req, this.options, refreshCookieName(this.options));
    // Only a person's session ends here; the cookies are cleared whatever they held.
    const person = token ? await this.people.check(token).then(() => true, () => false) : false;
    if (person) await run(() => this.web.signOut(token!));
    if (refresh) await this.kolab.revokeToken(refresh, { clientId: WEB_CLIENT }).catch(() => undefined);
    clearSessionCookie(res, this.options);
    clearInviteCookie(res, this.options);
  }

  /**
   * What an invite's link offers (W3.4), before signing in or after: its kolab, the access it grants
   * and who made it, while it is still good. The invite is then kept in an HttpOnly cookie that only
   * Kolab's own sign-in reads, so signing in with the identity provider can offer to join that kolab
   * (the consent page); signing in finishes it. One that isn't good is refused, saying nothing of why.
   */
  @Post('invite')
  @HttpCode(200)
  async openInvite(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: WebInviteToken): Promise<InvitePreview> {
    checkOrigin(req, this.options);
    if (!this.invitesOpened.take(clientAddress(req, this.options))) {
      throw new HttpException({ error: 'too_many_requests', message: 'too many invites opened from here just now; try again in a minute' }, 429);
    }
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const preview = await this.kolab.previewInvite(token);
    if (!preview) {
      clearInviteCookie(res, this.options);
      throw new NotFoundException({ error: 'not_found', message: 'this invite is unknown, already used, revoked or expired, or whoever made it can no longer invite; ask for a new one' });
    }
    setInviteCookie(res, this.options, token, INVITE_COOKIE_S);
    return preview;
  }

  /** Not now: the invite a link opened is dropped from this browser, so no later sign-in offers it. */
  @Delete('invite')
  @HttpCode(204)
  dropInvite(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    checkOrigin(req, this.options);
    clearInviteCookie(res, this.options);
  }

  /** The signed-in person accepts an invite: granted its access, and moved to its kolab in the same role. */
  @Post('invite/accept')
  @HttpCode(200)
  @UseGuards(WebSessionGuard)
  async acceptInvite(@WebSession() s: string, @Res({ passthrough: true }) res: Response, @Body() body: WebInviteToken): Promise<WebMe> {
    const token = await run(() => this.web.acceptInvite(s, body?.token));
    setSessionCookie(res, token, this.options);
    clearInviteCookie(res, this.options);
    return run(() => this.people.check(token));
  }

  /** Switches kolab or role: the session ends, a new one opens, and only the cookie holds its token. */
  @Post('switch')
  @HttpCode(200)
  @UseGuards(WebSessionGuard)
  async switchTo(@WebSession() s: string, @Res({ passthrough: true }) res: Response, @Body() body: WebSwitch): Promise<WebMe> {
    const token = await run(() => this.web.switchTo(s, body));
    setSessionCookie(res, token, this.options);
    return run(() => this.people.check(token));
  }

  /** A new kolab of the person's own, which the session then works in. */
  @Post('kolab')
  @HttpCode(201)
  @UseGuards(WebSessionGuard)
  async createKolab(@WebSession() s: string, @Res({ passthrough: true }) res: Response, @Body() body: WebCreateKolab): Promise<WebMe> {
    const token = await run(() => this.web.createKolab(s, body));
    setSessionCookie(res, token, this.options);
    return run(() => this.people.check(token));
  }
}

/** The web interface's API (API8): thin, over the same engine calls as the agents' verbs. */
@Controller('api')
@UseGuards(WebSessionGuard)
export class WebController {
  constructor(@Inject(WebService) private readonly web: WebService) {}

  @Get('me') me(@WebWho() me: WebMe) { return me; }
  @Get('overview') overview(@WebSession() s: string) { return run(() => this.web.overview(s)); }
  // Every list comes a page at a time (W2.21): ?cursor= is the next a page returned, ?limit= its size.

  @Get('nodes')
  nodes(@WebSession() s: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) { return run(() => this.web.nodes(s, page(c, l))); }

  /** ?state=open for those still open, ?state=settled for those answered or withdrawn; both by default. */
  @Get('queries')
  queries(@WebSession() s: string, @Query('state') state?: unknown, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    const st = one('state', state);
    if (st !== undefined && st !== 'open' && st !== 'settled') throw new BadRequestException({ error: 'bad_request', message: 'the state is open or settled' });
    return run(() => this.web.queries(s, { open: st === undefined ? undefined : st === 'open' }, page(c, l)));
  }

  @Get('marks') marks(@WebSession() s: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) { return run(() => this.web.marks(s, page(c, l))); }
  @Get('reviews') reviews(@WebSession() s: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) { return run(() => this.web.reviews(s, page(c, l))); }
  @Get('lineage') lineage(@WebSession() s: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) { return run(() => this.web.lineage(s, page(c, l))); }
  @Get('activity') activity(@WebSession() s: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) { return run(() => this.web.activity(s, page(c, l))); }

  // ---- invites (W3.4): for those with Admin in the session's kolab, as Kolab decides ----

  @Get('invites') invites(@WebSession() s: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) { return run(() => this.web.invites(s, page(c, l))); }

  @Post('invites')
  createInvite(@WebSession() s: string, @Body() body: WebCreateInvite) { return run(() => this.web.createInvite(s, body)); }

  @Post('invites/:id/revoke') @HttpCode(204)
  async revokeInvite(@WebSession() s: string, @Param('id') id: string) { await run(() => this.web.revokeInvite(s, id)); }

  // ---- who holds access (W3.6): for those with Admin in the session's kolab, as Kolab decides ----

  @Get('access') access(@WebSession() s: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) { return run(() => this.web.access(s, page(c, l))); }

  @Post('access/:actor') @HttpCode(200)
  changeGrant(@WebSession() s: string, @Param('actor') actor: string, @Body() body: WebChangeGrant) { return run(() => this.web.changeGrant(s, actor, body)); }

  @Post('access/:actor/remove') @HttpCode(200)
  removeGrant(@WebSession() s: string, @Param('actor') actor: string) { return run(() => this.web.removeGrant(s, actor)); }

  @Get('nodes/:name')
  node(@WebSession() s: string, @Param('name') name: string, @Query('version') v?: unknown) {
    const version = one('version', v);
    const seq = version === undefined ? undefined : Number(version);
    if (seq !== undefined && !Number.isInteger(seq)) return run(async () => { throw httpError(new Error(`no version ${version}`)); });
    return run(() => this.web.node(s, name, seq));
  }

  /** A node's versions, a page at a time, newest first (W2.21). */
  @Get('nodes/:name/versions')
  nodeVersions(@WebSession() s: string, @Param('name') name: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    return run(() => this.web.nodeVersions(s, name, page(c, l)));
  }

  /** The questions and notes on one element of a node (?element=), or on the node as a whole, a page at a time, newest first (W2.21). */
  @Get('nodes/:name/queries')
  nodeQueries(@WebSession() s: string, @Param('name') name: string, @Query('element') e?: unknown, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    return run(() => this.web.nodeQueries(s, name, one('element', e) ?? null, page(c, l)));
  }

  /** Another kolab's committed work, read in place (D49): its nodes, and one of them at a version. */
  @Get('kolabs/:kolab/nodes')
  foreignKolab(@WebSession() s: string, @Param('kolab') kolab: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    return run(() => this.web.foreignKolab(s, kolab, page(c, l)));
  }

  @Get('kolabs/:kolab/nodes/:name')
  foreignNode(@WebSession() s: string, @Param('kolab') kolab: string, @Param('name') name: string, @Query('version') v?: unknown) {
    const version = one('version', v);
    const seq = version === undefined ? undefined : Number(version);
    if (seq !== undefined && !Number.isInteger(seq)) return run(async () => { throw httpError(new Error(`no version ${version}`)); });
    return run(() => this.web.foreignNode(s, kolab, name, seq));
  }

  @Get('kolabs/:kolab/nodes/:name/versions')
  foreignVersions(@WebSession() s: string, @Param('kolab') kolab: string, @Param('name') name: string, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    return run(() => this.web.nodeVersions(s, name, page(c, l), kolab));
  }

  @Get('kolabs/:kolab/nodes/:name/queries')
  foreignQueries(@WebSession() s: string, @Param('kolab') kolab: string, @Param('name') name: string, @Query('element') e?: unknown,
    @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    return run(() => this.web.nodeQueries(s, name, one('element', e) ?? null, page(c, l), kolab));
  }

  @Post('nodes')
  createNode(@WebSession() s: string, @Body() body: WebCreateNode) { return run(() => this.web.createNode(s, body)); }

  @Post('nodes/:name/submit') @HttpCode(200)
  submit(@WebSession() s: string, @Param('name') name: string, @Body() body: WebSubmit) { return run(() => this.web.submit(s, name, body)); }

  @Post('nodes/:name/versions/:seq/resubmit') @HttpCode(200)
  resubmit(@WebSession() s: string, @Param('name') name: string, @Param('seq', seqOf) seq: number) { return run(() => this.web.resubmit(s, name, seq)); }

  @Post('nodes/:name/versions/:seq/abandon') @HttpCode(200)
  abandon(@WebSession() s: string, @Param('name') name: string, @Param('seq', seqOf) seq: number) { return run(() => this.web.abandon(s, name, seq)); }

  @Post('nodes/:name/versions/:seq/review') @HttpCode(200)
  review(@WebSession() s: string, @Param('name') name: string, @Param('seq', seqOf) seq: number, @Body() body: WebVerdict) {
    return run(() => this.web.review(s, name, seq, body));
  }

  @Post('marks/:id/clear') @HttpCode(200)
  clear(@WebSession() s: string, @Param('id') id: string) { return run(() => this.web.clear(s, id)); }

  @Post('marks/:id/resolve') @HttpCode(200)
  resolve(@WebSession() s: string, @Param('id') id: string, @Body() body: WebResolve) { return run(() => this.web.resolve(s, id, body)); }

  @Post('queries')
  ask(@WebSession() s: string, @Body() body: WebAsk) { return run(() => this.web.ask(s, body)); }

  @Post('queries/:id/answer') @HttpCode(200)
  answer(@WebSession() s: string, @Param('id') id: string, @Body() body: WebAnswer) { return run(() => this.web.answer(s, id, body?.answer)); }

  // ---- case files and rulings: one route per verb (CASE1–CASE7, D49, D51) ----

  @Get('cases')
  cases(@WebSession() s: string, @Query('state') state?: unknown, @Query('mine') mine?: unknown, @Query('node') node?: unknown,
    @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    return run(() => this.web.cases(s, { state: one('state', state), mine: one('mine', mine) === 'true', node: one('node', node) }, page(c, l)));
  }

  @Get('cases/:id')
  readCase(@WebSession() s: string, @Param('id') id: string) { return run(() => this.web.readCase(s, id)); }

  @Post('cases')
  openCase(@WebSession() s: string, @Body() body: WebOpenCase) { return run(() => this.web.openCase(s, body)); }

  @Post('cases/:id/positions')
  addPosition(@WebSession() s: string, @Param('id') id: string, @Body() body: WebPosition) { return run(() => this.web.addPosition(s, id, body)); }

  @Post('cases/:id/rule')
  ruleCase(@WebSession() s: string, @Param('id') id: string, @Body() body: WebRuleCase) { return run(() => this.web.ruleCase(s, id, body)); }

  @Get('rulings')
  rulings(@WebSession() s: string, @Query('node') node?: unknown, @Query('cursor') c?: unknown, @Query('limit') l?: unknown) {
    return run(() => this.web.rulings(s, one('node', node), page(c, l)));
  }

  @Post('rulings')
  ruleDirect(@WebSession() s: string, @Body() body: WebRuleDirect) { return run(() => this.web.ruleDirect(s, body)); }
}
