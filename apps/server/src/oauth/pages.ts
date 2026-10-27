import { createHash } from 'node:crypto';
import type { Response } from 'express';
import type { Access, InvitePreview, Role } from '@konjir/types';

/** Text made safe for HTML, in content and in attribute values. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The pages' one style sheet, inline, allowed by its hash: the pages load nothing, and run no script. */
const STYLE = `
:root{color-scheme:dark light;--bg:#0f1115;--fg:#e8e6e3;--muted:#9aa0a6;--line:#2a2e36;--accent:#e0a458;--card:#161a20;--err:#ff8a80}
@media (prefers-color-scheme: light){:root{--bg:#f7f5f0;--fg:#1d1f23;--muted:#5d636b;--line:#dcd8cf;--accent:#9a5b13;--card:#fff;--err:#b3261e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:40px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin:16px 0}
fieldset{border:0;padding:0;margin:16px 0}legend{font-weight:600;margin-bottom:6px}
label.opt{display:flex;gap:8px;align-items:flex-start;padding:6px 0}label.opt small{display:block;color:var(--muted)}
input[type=text]{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;margin-top:4px}
.row{display:flex;gap:8px;margin-top:20px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#111;font-weight:600}.err{color:var(--err);font-weight:600}
code{font-family:ui-monospace,Menlo,monospace;font-size:13px}
dl.locked{margin:16px 0}dl.locked dt{font-weight:600;margin-top:10px}dl.locked dd{margin:2px 0 0}dl.locked small{display:block;color:var(--muted)}`;
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');
const csp = (formTargets: string[]) =>
  [`default-src 'none'`, `style-src 'sha256-${STYLE_HASH}'`, `form-action ${["'self'", ...formTargets].join(' ')}`, `frame-ancestors 'none'`, `base-uri 'none'`].join('; ');

/**
 * Where a form on the consent page may lead, as a CSP source, besides Kolab itself: the redirect
 * URI the client gets its answer at. A browser holds a form submission's redirects to the page's
 * `form-action` too (CSP3), so under `form-action 'self'` alone Kolab's 303 to an app's own
 * listener, http://127.0.0.1:<port>/… for OpenCode, is blocked after the consent has gone through.
 * A redirect URI is https, or http on loopback, on a host registration checked (validRedirectHost),
 * so this is its origin, port and all. The one exception is any IPv6 literal host, which a CSP
 * source can't name: loopback http, `http://[::1]:<port>`, or https, `https://[2001:db8::1]/…`
 * (registration takes either). Then the scheme alone, `http:` or `https:` (CSP3 lets `http:` match
 * https too).
 * That is broader, but the page's only form posts to Kolab, and Kolab's 303 goes only to the
 * sign-in's own registered redirect URI. Anything else, none.
 */
export function formActionSource(redirectUri: string): string | undefined {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (/^\[[0-9a-f:.]+\]$/.test(u.hostname)) return u.protocol;
  return /^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(u.origin) ? u.origin : undefined;
}

/**
 * Sends one of the authorization server's pages: no script, nothing loaded from anywhere, never
 * framed (clickjacking), never cached, and a referrer for Kolab alone, so a code or state in its URL
 * goes nowhere else. The policy is `same-origin`, never `no-referrer`: under `no-referrer` a browser
 * sends `Origin: null` with the page's own form POST (Fetch, "serializing a request origin"), and
 * POST /oauth/consent refuses any origin but Kolab's. Its forms post to Kolab only, and lead on to
 * Kolab or to `formTargets` (formActionSource).
 */
export function sendPage(res: Response, status: number, title: string, body: string, opts: { formTargets?: string[] } = {}) {
  res.status(status);
  res.setHeader('content-security-policy', csp(opts.formTargets ?? []));
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('cache-control', 'no-store');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Kolab</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`);
}

/** A page that says what went wrong and what to do; it never redirects anywhere. */
export function sendError(res: Response, status: number, message: string) {
  sendPage(res, status, 'Sign-in stopped', `<h1>Sign-in stopped</h1><div class="card"><p class="err">${esc(message)}</p>
<p class="muted">Close this tab and start again from the app you were connecting, or from Kolab's own page.</p></div>`);
}

const describe = (a: Access) => (a.level === 'write' ? `Write on ${a.layers.join(' and ')}` : a.level ? a.level[0].toUpperCase() + a.level.slice(1) : 'no access');

export interface ConsentView {
  /** The sign-in's id, which names its binding cookie: not secret. */
  signIn: string;
  csrf: string;
  client: string;
  /** Where the client receives its answer: what the person can check the client by, since its name is its own say-so. */
  redirect: string;
  /** The web interface, which is for people: no agents. */
  web: boolean;
  person: string; login: string; provider: string; created: boolean;
  kolabs: { id: string; title: string; access: Access }[];
  agents: string[];
  /** Those of `agents` signed in now: choosing one ends that session (ENF4), and the page says so. */
  signedIn?: string[];
  /**
   * What to preselect: from the client's scope, or the last choice. `kolab` is a form value:
   * `kolab:<name>`, `@new` or `@invite`, so no kolab's name can be taken for either choice.
   */
  pick: { kolab?: string; role?: Role; as?: string; label?: string; newName?: string; newTitle?: string };
  error?: string;
  /** The invite the person opened, while it is still good (W3.4): the web interface's sign-in only. */
  invite?: InvitePreview;
  /**
   * The agent, kolab and role the client's scope names together (D97): the
   * page offers those alone, or, when the agent isn't a live agent of the person's or the kolab
   * isn't one they reach, nothing to allow. `step` is which of several sign-ins this is, display only.
   */
  lock?: { agent: string; kolab: string; role: Role; step: { n: number; of: number } | null };
}

const ROLE_SHOWN: Record<Role, [string, string]> = {
  product: ['Product', 'Writes the functional layer: what it does'],
  engineer: ['Engineer', 'Writes the technical layer: how it\'s built'],
};

/** The title and heading of a page locked to one agent: the agent, and which of several sign-ins it is. */
export function lockedTitle(lock: NonNullable<ConsentView['lock']>, allowed: boolean): string {
  const step = lock.step && lock.step.of > 1 ? ` (agent ${lock.step.n} of ${lock.step.of})` : '';
  return allowed ? `Sign in as ${lock.agent}${step}` : `Sign-in can't be allowed${step}`;
}

/** Whether a locked page has anything to allow: the agent is a live agent of the person's, and the kolab one they reach. */
export const lockAllowed = (v: ConsentView) => !!v.lock && v.agents.includes(v.lock.agent) && v.kolabs.some((k) => k.id === v.lock!.kolab);

/**
 * The consent page locked to the agent, kolab and role the client's scope names (D97): no
 * list of agents, no new agent and no Yourself, nor any other kolab or role, so
 * nothing on it can sign in anyone else; the server refuses any other choice too. Its title and
 * heading name the agent, and "agent N of M" when `konjir connect` signs several in. An agent that
 * isn't the person's, or a kolab they can't reach, is never named (D59): the page says it can't
 * be allowed, and offers only Deny.
 */
function lockedConsentPage(v: ConsentView & { lock: NonNullable<ConsentView['lock']> }): string {
  const { lock } = v;
  const allowed = lockAllowed(v);
  const kolab = v.kolabs.find((k) => k.id === lock.kolab);
  const step = lock.step && lock.step.of > 1
    ? `<p><strong>Agent ${lock.step.n} of ${lock.step.of}.</strong> Each agent signs in on a page of its own, one after another${allowed ? `: this one is for <code>${esc(lock.agent)}</code> alone` : ''}.</p>` : '';
  const hidden = `<input type="hidden" name="sign_in" value="${esc(v.signIn)}">
<input type="hidden" name="csrf" value="${esc(v.csrf)}">`;
  const intro = `<p class="muted">Signed in with ${esc(v.provider)} as <code>${esc(v.login)}</code>. ${v.created ? `Welcome: you are <code>${esc(v.person)}</code> here, new to Kolab.` : `You are <code>${esc(v.person)}</code> here.`}</p>`;
  const asks = `<p><strong>${esc(v.client)}</strong> asks to work in Kolab, and gets its answer at <code>${esc(v.redirect)}</code>. Its name is what it calls itself: allow it only if you just connected it.</p>`;
  if (!allowed) {
    const why = !v.agents.includes(lock.agent)
      ? 'it asks to work as an agent that isn\'t a live agent of yours'
      : 'it asks to work in a kolab you can\'t reach';
    return `<h1>${esc(lockedTitle(lock, false))}</h1>
${intro}
<form class="card" method="post" action="/oauth/consent">
${step}${asks}
<p class="err" role="alert">This sign-in can't be allowed: ${why}. Deny it, then check the app's configuration, or run konjir connect again.</p>
${hidden}
<div class="row"><button class="primary" type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
  }
  const [roleName, roleSays] = ROLE_SHOWN[lock.role];
  return `<h1>Sign in as <code>${esc(lock.agent)}</code>${lock.step && lock.step.of > 1 ? ` <span class="muted">(agent ${lock.step.n} of ${lock.step.of})</span>` : ''}</h1>
${intro}
<form class="card" method="post" action="/oauth/consent">
${step}${asks}
${v.error ? `<p class="err" role="alert">${esc(v.error)}</p>` : ''}
${hidden}
<input type="hidden" name="as" value="agent:${esc(lock.agent)}">
<input type="hidden" name="kolab" value="kolab:${esc(lock.kolab)}">
<input type="hidden" name="role" value="${esc(lock.role)}">
<dl class="locked">
<dt>Work as</dt><dd><code>${esc(lock.agent)}</code><small>${v.signedIn?.includes(lock.agent) ? '<strong>Signed in elsewhere now: allowing this ends that session.</strong> An agent holds one session at a time.' : 'An agent of yours: its own actor and session, never more access than you (D30)'}</small></dd>
<dt>In the kolab</dt><dd><code>${esc(kolab!.id)}</code> ${esc(kolab!.title)}<small>You hold ${esc(describe(kolab!.access))}</small></dd>
<dt>As</dt><dd>${roleName}<small>${roleSays}</small></dd>
</dl>
<p class="muted">This page signs in <code>${esc(lock.agent)}</code> and no one else. To sign in as anyone else, deny it and start again from your app.</p>
<div class="row"><button class="primary" type="submit" name="decision" value="allow">Allow as ${esc(lock.agent)}</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
}

/**
 * The consent page (D55): who signed in, which client asks, and the choice of who it acts as, in
 * which kolab and role. One session per actor (ENF4): acting as yourself ends your other session,
 * so an MCP client defaults to an agent of yours (D30): a new one unless the controller picks one,
 * and an agent signed in now is marked, since choosing it ends that session too.
 */
export function consentPage(v: ConsentView): string {
  if (v.lock && !v.web) return lockedConsentPage({ ...v, lock: v.lock });
  const checked = (on: boolean) => (on ? ' checked' : '');
  // An invite is chosen already only for someone with no kolab yet; anyone else picks, explicitly (W3.4).
  const kolab = v.pick.kolab ?? (v.invite ? (v.kolabs.length ? '' : '@invite') : v.kolabs[0] ? `kolab:${v.kolabs[0].id}` : '@new');
  const as = v.pick.as ?? (v.web ? 'self' : 'new-agent');
  const role = v.pick.role ?? 'product';
  const who = v.web ? '' : `<fieldset><legend>Work as</legend>
${v.agents.map((a) => `<label class="opt"><input type="radio" name="as" value="agent:${esc(a)}"${checked(as === `agent:${a}`)}><span><code>${esc(a)}</code><small>${v.signedIn?.includes(a) ? '<strong>Signed in elsewhere now: choosing it here ends that session.</strong> An agent holds one session at a time.' : 'An agent of yours: its own actor and session, never more access than you (D30)'}</small></span></label>`).join('\n')}
<label class="opt"><input type="radio" name="as" value="new-agent"${checked(as === 'new-agent')}><span>A new agent of yours, <code>${esc(v.person)}-</code><input type="text" name="agent_label" value="${esc(v.pick.label ?? 'agent')}" maxlength="24" aria-label="The new agent's name" pattern="[a-z0-9][a-z0-9\\-]*"></span></label>
<label class="opt"><input type="radio" name="as" value="self"${checked(as === 'self')}><span>Yourself, <code>${esc(v.person)}</code><small>Ends any other session you hold open, such as Kolab's web page: one session per person</small></span></label>
</fieldset>`;
  return `<h1>Sign in to Kolab</h1>
<p class="muted">Signed in with ${esc(v.provider)} as <code>${esc(v.login)}</code>. ${v.created ? `Welcome: you are <code>${esc(v.person)}</code> here, new to Kolab.` : `You are <code>${esc(v.person)}</code> here.`}</p>
<form class="card" method="post" action="/oauth/consent">
<p><strong>${esc(v.client)}</strong> ${v.web ? 'opens a session for you.' : `asks to work in Kolab, and gets its answer at <code>${esc(v.redirect)}</code>. Its name is what it calls itself: allow it only if you just connected it. It gets a token that lasts 15 minutes and renews itself until you sign out or revoke it.`}</p>
${v.error ? `<p class="err" role="alert">${esc(v.error)}</p>` : ''}
<input type="hidden" name="sign_in" value="${esc(v.signIn)}">
<input type="hidden" name="csrf" value="${esc(v.csrf)}">
${who}
<fieldset><legend>In the kolab</legend>
${v.invite ? `<label class="opt"><input type="radio" name="kolab" value="@invite"${checked(kolab === '@invite')}><span>Join <code>${esc(v.invite.kolab)}</code> ${esc(v.invite.title)}<small>${esc(v.invite.invited_by)} invites you, with ${esc(describe(v.invite))}, owned by ${esc(v.invite.owner)}. Choose it only if you expected this invite.</small></span></label>` : ''}
${v.kolabs.map((k) => `<label class="opt"><input type="radio" name="kolab" value="kolab:${esc(k.id)}"${checked(kolab === `kolab:${k.id}`)}><span><code>${esc(k.id)}</code> ${esc(k.title)}<small>You hold ${esc(describe(k.access))}</small></span></label>`).join('\n')}
<label class="opt"><input type="radio" name="kolab" value="@new"${checked(kolab === '@new')}><span>A new private kolab of your own
<input type="text" name="new_kolab_name" value="${esc(v.pick.newName ?? '')}" maxlength="40" placeholder="short-name" aria-label="The new kolab's short name">
<input type="text" name="new_kolab_title" value="${esc(v.pick.newTitle ?? '')}" maxlength="100" placeholder="A name people read" aria-label="The new kolab's title"></span></label>
</fieldset>
<fieldset><legend>As</legend>
<label class="opt"><input type="radio" name="role" value="product"${checked(role === 'product')}><span>Product<small>Writes the functional layer: what it does</small></span></label>
<label class="opt"><input type="radio" name="role" value="engineer"${checked(role === 'engineer')}><span>Engineer<small>Writes the technical layer: how it's built</small></span></label>
</fieldset>
<div class="row"><button class="primary" type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
}

/** A time as the raise pages show it: to the second, in UTC. */
const utc = (iso: string) => iso.replace('T', ' ').replace(/(\.\d+)?Z$/, ' UTC');

export interface RaiseView {
  /** The raise's sign-in id, which names its binding cookie: not secret. */
  signIn: string;
  csrf: string;
  person: string; login: string; provider: string;
  /** The session the raise is for: its key (whoami's `session`) and when it started. */
  session: string; sessionStarted: string;
  /**
   * The client that session signed in through, by what Kolab knows: Kolab's own web page, or a
   * registered client's id and the origins it receives codes at, beside the name it gave itself,
   * which anyone registering can choose.
   */
  client: { id: string; firstParty: boolean; name: string | null; redirectOrigins: string[] };
  /** When the request lapses, and how long a raise lasts, in minutes. */
  expiresAt: string; minutes: number;
}

/** The client a raise's session signed in through, by facts Kolab controls; a self-chosen name only marked as such. */
function clientShown(c: RaiseView['client']): string {
  if (c.firstParty) return 'Kolab\'s own web page';
  const where = c.redirectOrigins.length ? `, which receives its sign-ins at ${c.redirectOrigins.map((o) => `<code>${esc(o)}</code>`).join(', ')}` : '';
  const named = c.name ? `. It calls itself “${esc(c.name)}”, a name it chose when it registered: <strong>unverified</strong>, so don't go by it` : '';
  return `an app registered with Kolab as <code>${esc(c.id)}</code>${where}${named}`;
}

/**
 * The page that completes an admin raise (W2.22, Lee's ruling of 2026-10-23): reached only through
 * a sign-in with the identity provider in a browser, as the session's own person (GitHub's account
 * picker: GitHub has no forced re-authentication, so this is not a password or 2FA check). Nothing
 * else raises a session, so the page says plainly what raising gives, to which session, and how the
 * request was made, naming the session by what Kolab itself knows of it.
 */
export function raisePage(v: RaiseView): string {
  return `<h1>Raise your session to run Konjir's admin verbs</h1>
<p class="muted">Signed in with ${esc(v.provider)} as <code>${esc(v.login)}</code>. You are <code>${esc(v.person)}</code> here, a Konjir admin.</p>
<form class="card" method="post" action="/oauth/consent">
<p>This request was made over MCP by a session of yours: <code>${esc(v.person)}</code>'s session <code>${esc(v.session)}</code> (whoami's <code>session</code>), signed in at ${esc(utc(v.sessionStarted))} through ${clientShown(v.client)}.</p>
<p>Raised, for ${v.minutes} minutes, whatever drives that session runs every admin verb as you: applying rulings without review, granting access, making admins and opening sessions, each recorded as yours.</p>
<p><strong>Raise it only if you asked for this yourself, just now, from that session.</strong> If an agent, a message or anyone else sent you here, choose Don't raise. This link lasts until ${esc(utc(v.expiresAt))} and works once: raised or not, it is used up.</p>
<input type="hidden" name="sign_in" value="${esc(v.signIn)}">
<input type="hidden" name="csrf" value="${esc(v.csrf)}">
<div class="row"><button class="primary" type="submit" name="decision" value="allow">Raise for ${v.minutes} minutes</button><button type="submit" name="decision" value="deny">Don't raise</button></div>
</form>`;
}

/** What the person sees once a raise is done, or declined. */
export function raisedPage(v: { person: string; until?: string }): string {
  return v.until
    ? `<h1>Raised</h1><div class="card"><p>Your session runs Konjir's admin verbs, as <code>${esc(v.person)}</code>, until ${esc(utc(v.until))}.</p>
<p class="muted">Go back to your app. Lower it sooner with <code>konjir admin_elevate lower=true</code>. You can close this tab.</p></div>`
    : `<h1>Not raised</h1><div class="card"><p>Your session wasn't raised, and the link is used up.</p><p class="muted">You can close this tab.</p></div>`;
}
