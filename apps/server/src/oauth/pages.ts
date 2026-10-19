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
code{font-family:ui-monospace,Menlo,monospace;font-size:13px}`;
const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64');
const csp = (formTargets: string[]) =>
  [`default-src 'none'`, `style-src 'sha256-${STYLE_HASH}'`, `form-action ${["'self'", ...formTargets].join(' ')}`, `frame-ancestors 'none'`, `base-uri 'none'`].join('; ');

/**
 * Where a form on the consent page may lead, as a CSP source, besides Kolab itself: the redirect
 * URI the client gets its answer at. A browser holds a form submission's redirects to the page's
 * `form-action` too (CSP3), so under `form-action 'self'` alone Kolab's 303 to an app's own
 * listener, http://127.0.0.1:<port>/… for OpenCode, is blocked after the consent has gone through.
 * Its origin, port and all; or, where a CSP source can't name the host (an IPv6 literal), or for an
 * app's own scheme, the scheme alone.
 */
export function formActionSource(redirectUri: string): string | undefined {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return undefined; }
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    return /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(u.origin) ? u.origin : u.protocol;
  }
  return /^[a-z][a-z0-9+.-]*:$/i.test(u.protocol) ? u.protocol : undefined;
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
  /**
   * What to preselect: from the client's scope, or the last choice. `kolab` is a form value:
   * `kolab:<name>`, `@new` or `@invite`, so no kolab's name can be taken for either choice.
   */
  pick: { kolab?: string; role?: Role; as?: string; label?: string; newName?: string; newTitle?: string };
  error?: string;
  /** The invite the person opened, while it is still good (W3.4): the web interface's sign-in only. */
  invite?: InvitePreview;
}

/**
 * The consent page (D55): who signed in, which client asks, and the choice of who it acts as, in
 * which kolab and role. One session per actor (ENF4): acting as yourself ends your other session,
 * so an MCP client defaults to an agent of yours (D30).
 */
export function consentPage(v: ConsentView): string {
  const checked = (on: boolean) => (on ? ' checked' : '');
  // An invite is chosen already only for someone with no kolab yet; anyone else picks, explicitly (W3.4).
  const kolab = v.pick.kolab ?? (v.invite ? (v.kolabs.length ? '' : '@invite') : v.kolabs[0] ? `kolab:${v.kolabs[0].id}` : '@new');
  const as = v.pick.as ?? (v.web ? 'self' : v.agents[0] ? `agent:${v.agents[0]}` : 'new-agent');
  const role = v.pick.role ?? 'product';
  const who = v.web ? '' : `<fieldset><legend>Work as</legend>
${v.agents.map((a) => `<label class="opt"><input type="radio" name="as" value="agent:${esc(a)}"${checked(as === `agent:${a}`)}><span><code>${esc(a)}</code><small>An agent of yours: its own actor and session, never more access than you (D30)</small></span></label>`).join('\n')}
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
