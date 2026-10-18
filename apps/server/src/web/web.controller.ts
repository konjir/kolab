import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseIntPipe, Post, Query, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Kolab } from '@konjir/engine';
import type { WebAnswer, WebAsk, WebCreateNode, WebMe, WebResolve, WebSignIn, WebSubmit, WebVerdict } from '@konjir/types';
import { KOLAB, WEB_OPTIONS, type WebOptions } from '../tokens.js';
import { WebSession, WebSessionGuard, checkOrigin, clearSessionCookie, setSessionCookie } from './auth.js';
import { WebService, httpError } from './web.service.js';

/** Runs a call, turning Kolab's errors into the API's (WebError), with any token masked. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) { throw httpError(e); }
}

const seqOf = new ParseIntPipe({ errorHttpStatusCode: 400 });

/** Signing in and out of the web interface (see auth.ts). */
@Controller('api/session')
export class WebSessionController {
  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(WEB_OPTIONS) private readonly options: WebOptions,
    @Inject(WebService) private readonly web: WebService,
  ) {}

  /** Checks the token is an open session, and keeps it in the page's cookie. */
  @Post()
  @HttpCode(200)
  async signIn(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: WebSignIn): Promise<WebMe> {
    checkOrigin(req, this.options);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (token && token === this.options.adminToken) {
      throw new UnauthorizedException({ error: 'unauthorized', message: 'the admin token works in no kolab: sign in with a session token, one actor in one kolab and one role' });
    }
    if (!token || !(await run(() => this.kolab.sessionOpen(token)))) {
      throw new UnauthorizedException({ error: 'unauthorized', message: 'that isn\'t an open Konjir session token: it may have been mistyped, or its session ended' });
    }
    const me = await run(() => this.web.me(token));
    setSessionCookie(res, token, this.options);
    return me;
  }

  /** Signs the page out. The session itself stays open: an admin ends it (konjir admin_end_session). */
  @Delete()
  @HttpCode(204)
  signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    checkOrigin(req, this.options);
    clearSessionCookie(res, this.options);
  }
}

/** The web interface's API (API8): thin, over the same engine calls as the agents' verbs. */
@Controller('api')
@UseGuards(WebSessionGuard)
export class WebController {
  constructor(@Inject(WebService) private readonly web: WebService) {}

  @Get('me') me(@WebSession() s: string) { return run(() => this.web.me(s)); }
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
}
