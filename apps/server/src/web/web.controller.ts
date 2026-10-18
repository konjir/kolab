import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  WebAnswer, WebAsk, WebCreateKolab, WebCreateNode, WebMe, WebOpenCase, WebPosition, WebResolve, WebRuleCase, WebRuleDirect, WebSignIn, WebSubmit,
  WebSwitch, WebVerdict,
} from '@konjir/types';
import { WEB_OPTIONS, type WebOptions } from '../tokens.js';
import { WebPeople, WebSession, WebSessionGuard, WebWho, checkOrigin, clearSessionCookie, setSessionCookie, tokenOf } from './auth.js';
import { WebService, httpError } from './web.service.js';

/** Runs a call, turning Kolab's errors into the API's (WebError), with any token masked. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw httpError(e); }
}

const seqOf = new ParseIntPipe({ errorHttpStatusCode: 400 });

/** Signing in and out of the web interface, and switching kolab or role (see auth.ts). */
@Controller('api/session')
export class WebSessionController {
  constructor(
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
    @Inject(WebService) private readonly web: WebService,
    @Inject(WebPeople) private readonly people: WebPeople,
  ) {}

  /** Checks the token is a person's open session, and keeps it in the page's cookie. */
  @Post()
  @HttpCode(200)
  async signIn(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: WebSignIn): Promise<WebMe> {
    checkOrigin(req, this.options);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    const me = await run(() => this.people.check(token || undefined));
    setSessionCookie(res, token, this.options);
    return me;
  }

  /** Signs out: a person's session ends, so its token is revoked everywhere, and the cookie is cleared. */
  @Delete()
  @HttpCode(204)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    checkOrigin(req, this.options);
    const token = tokenOf(req, this.options);
    // Only a person's session ends here; the cookie is cleared whatever it held.
    const person = token ? await this.people.check(token).then(() => true, () => false) : false;
    if (person) await run(() => this.web.signOut(token!));
    clearSessionCookie(res, this.options);
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
  @Get('queries') async queries(@WebSession() s: string) { return { queries: await run(() => this.web.queries(s)) }; }
  @Get('marks') async marks(@WebSession() s: string) { return { marks: await run(() => this.web.marks(s)) }; }
  @Get('reviews') reviews(@WebSession() s: string) { return run(() => this.web.reviews(s)); }
  @Get('lineage') lineage(@WebSession() s: string) { return run(() => this.web.lineage(s)); }
  @Get('activity') activity(@WebSession() s: string) { return run(() => this.web.activity(s)); }

  @Get('nodes/:name')
  node(@WebSession() s: string, @Param('name') name: string, @Query('version') version?: string) {
    const seq = version === undefined || version === '' ? undefined : Number(version);
    if (seq !== undefined && !Number.isInteger(seq)) return run(async () => { throw httpError(new Error(`no version ${version}`)); });
    return run(() => this.web.node(s, name, seq));
  }

  /** Another kolab's committed work, read in place (D49): its nodes, and one of them at a version. */
  @Get('kolabs/:kolab/nodes')
  foreignKolab(@WebSession() s: string, @Param('kolab') kolab: string) { return run(() => this.web.foreignKolab(s, kolab)); }

  @Get('kolabs/:kolab/nodes/:name')
  foreignNode(@WebSession() s: string, @Param('kolab') kolab: string, @Param('name') name: string, @Query('version') version?: string) {
    const seq = version === undefined || version === '' ? undefined : Number(version);
    if (seq !== undefined && !Number.isInteger(seq)) return run(async () => { throw httpError(new Error(`no version ${version}`)); });
    return run(() => this.web.foreignNode(s, kolab, name, seq));
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
  cases(@WebSession() s: string, @Query('state') state?: string, @Query('mine') mine?: string, @Query('node') node?: string) {
    return run(() => this.web.cases(s, { state: state || undefined, mine: mine === 'true', node: node || undefined }));
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
  async rulings(@WebSession() s: string, @Query('node') node?: string) { return { rulings: await run(() => this.web.rulings(s, node || undefined)) }; }

  @Post('rulings')
  ruleDirect(@WebSession() s: string, @Body() body: WebRuleDirect) { return run(() => this.web.ruleDirect(s, body)); }
}
