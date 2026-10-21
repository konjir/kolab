import { useState, type FormEvent } from 'react';
import type { InvitePreview, InviteView, Layer, WebInviteMade, WebInvitesView, WebMe, WebOverview } from '@konjir/types';
import { api } from '../api.js';
import { ago } from '../util.js';
import { Pill } from './bits.js';
import { useRead } from './Pages.js';
import type { Act } from './Marks.js';

/**
 * A person's first session with no admin (W3.4; P15, D55): connect a harness with one command,
 * invite a teammate with a link, and join a kolab from one. Kolab decides each step; the page only
 * says how.
 */

/** Access in words: "Write on the functional layer", "Read". */
export function accessWords(a: { level: string | null; layers: Layer[] }): string {
  if (!a.level) return 'no access';
  const level = a.level[0].toUpperCase() + a.level.slice(1);
  if (a.level !== 'write') return level;
  return a.layers.length === 2 ? 'Write on both layers' : `Write on the ${a.layers[0]} layer`;
}

/** The link an invite's secret makes: to this Kolab's page, the secret in the fragment, which no request carries. */
export const inviteLink = (token: string, origin = location.origin) => `${origin}/#/invite/${token}`;

/** A command to copy: shown as it is, with a button that copies it. */
export function Command({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cmd">
      <code aria-label={label} className={text.includes('\n') ? 'block' : undefined}>{text}</code>
      <button type="button" className="btn quiet" onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => undefined);
      }}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/** OpenCode's config for Kolab: an `mcp.konjir` entry for a remote server, in opencode.json. */
export const openCodeConfig = (mcp: string) => JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { konjir: { type: 'remote', url: mcp } } }, null, 2);

/** `konjir connect` for a harness (W3.7, D59): one agent of yours per entry, product and engineer by default. */
export const konjirConnect = (harness: 'opencode' | 'claude', origin: string, kolab: string) => `npx konjir connect ${harness} --url ${origin} --kolab ${kolab}`;

/**
 * Connecting a harness, by one of two routes. Over MCP (Claude Code, OpenCode, any client that
 * speaks MCP's authorization), the harness needs only the URL and signs in on Kolab's own page,
 * where the person chooses the agent it works as (D30, D56), the kolab and the role; its agent then
 * calls the konjir_instructions tool, since such an agent usually has no konjir CLI. In a shell,
 * the konjir CLI signs in with `konjir login`, and `konjir instructions` gives the same text.
 */
export function ConnectView({ me, origin = location.origin }: { me: WebMe; origin?: string }) {
  const mcp = `${origin}/mcp`;
  return (
    <>
      <section className="summary" aria-label="Connect a harness">
        <h1>Connect a harness</h1>
        <span className="fact">An agent works in Kolab through its own harness, as an agent of yours: its own actor and session, never more access than you (D30). Connect it with one command, over MCP by hand, or through the konjir CLI in a shell.</span>
      </section>
      <section className="newk" aria-labelledby="c-connect">
        <h2 className="section-title" id="c-connect">One command: konjir connect</h2>
        <p className="why-not">Run it in your project. It signs the konjir CLI in as you (with your browser, the first time), makes or reuses one agent of yours per entry, <span className="mono">{me.actor}-product</span> and <span className="mono">{me.actor}-engineer</span> by default, and shows the change to the harness’s config before it writes it. It writes no token. Each entry then signs in as its own agent: Kolab’s page arrives with the agent, {me.kolab} and the role chosen, for you to check and allow.</p>
        <h3 id="c-connect-opencode">OpenCode</h3>
        <Command label="Connect OpenCode with konjir connect" text={konjirConnect('opencode', origin, me.kolab)} />
        <h3 id="c-connect-claude">Claude Code</h3>
        <Command label="Connect Claude Code with konjir connect" text={konjirConnect('claude', origin, me.kolab)} />
        <p className="why-not">Choose the agents with <span className="mono">--agent &lt;label&gt;[:product|engineer]</span>, once for each; <span className="mono">--global</span> writes your own settings rather than the project’s.</p>
      </section>
      <section className="newk" aria-labelledby="c-mcp">
        <h2 className="section-title" id="c-mcp">Over MCP: Claude Code, OpenCode</h2>
        <p className="why-not">Or by hand: add Kolab as an MCP server and sign in. On Kolab’s page, choose the agent it works as (a new one of yours by default), the kolab ({me.kolab}) and its role. Then ask the agent to call <span className="mono">konjir_instructions</span> before its first change: it returns the rules and {me.kolab}’s precedent. No CLI is needed.</p>
        <h3 id="c-claude">Claude Code</h3>
        <p className="why-not">Add it, then run <span className="mono">/mcp</span> in Claude Code and sign in.</p>
        <Command label="Add Kolab to Claude Code" text={`claude mcp add --transport http konjir ${mcp}`} />
        <h3 id="c-opencode">OpenCode</h3>
        <p className="why-not">Merge this <span className="mono">mcp.konjir</span> entry into your <span className="mono">opencode.json</span>, keeping what is already there (or start the file with it), then sign in.</p>
        <Command label="OpenCode's opencode.json" text={openCodeConfig(mcp)} />
        <Command label="Sign OpenCode in" text="opencode mcp auth konjir" />
        <h3 id="c-other">Any other MCP client</h3>
        <p className="why-not">One that speaks MCP’s authorization needs only the URL, and signs in as Claude Code does.</p>
        <Command label="Kolab's MCP URL" text={mcp} />
      </section>
      <section className="newk" aria-labelledby="c-shell">
        <h2 className="section-title" id="c-shell">In a shell: the konjir CLI, for Codex or you</h2>
        <p className="why-not">The konjir CLI signs in with your browser and keeps the sign-in, renewing it by itself. Every konjir command then works as the agent you chose; start with <span className="mono">konjir instructions</span>.</p>
        <Command label="Sign the konjir CLI in" text={`npx konjir login --url ${mcp} --kolab ${me.kolab} --role ${me.role}`} />
        <Command label="Read the instructions with the konjir CLI" text="npx konjir instructions" />
      </section>
    </>
  );
}

const LEVELS: { value: string; label: string; level: InviteView['level']; layers?: Layer[] }[] = [
  { value: 'read', label: 'Read: reads and asks', level: 'read' },
  { value: 'triage', label: 'Triage', level: 'triage' },
  { value: 'write-functional', label: 'Write on the functional layer: product', level: 'write', layers: ['functional'] },
  { value: 'write-technical', label: 'Write on the technical layer: engineering', level: 'write', layers: ['technical'] },
  { value: 'write', label: 'Write on both layers', level: 'write', layers: ['functional', 'technical'] },
  { value: 'maintain', label: 'Maintain', level: 'maintain' },
];

/**
 * Inviting people to the session's kolab (W3.4): for those with Admin there. An invite is a link,
 * shown once, that grants its access to whoever signs in with it, once, within 7 days.
 */
export function PeopleView({ me, overview, tick, act }: { me: WebMe; overview: WebOverview; tick: number; act: Act }) {
  if (me.access.level === 'admin') return <Invites me={me} overview={overview} tick={tick} act={act} />;
  return (
    <section className="newk" aria-labelledby="p-title">
      <h2 className="section-title" id="p-title">People in {me.kolab}</h2>
      <p className="why-not">Those with Admin in {me.kolab} invite people to it; you hold {accessWords(me.access)}. Ask its owner, {overview.kolab.owner}.</p>
    </section>
  );
}

function Invites({ me, overview, tick, act }: { me: WebMe; overview: WebOverview; tick: number; act: Act }) {
  const [choice, setChoice] = useState('write-technical');
  const [made, setMade] = useState<{ link: string; invite: InviteView }>();
  const [again, setAgain] = useState(0);
  const { data, error } = useRead<WebInvitesView>('invites', tick + again);
  const make = async (e: FormEvent) => {
    e.preventDefault();
    const c = LEVELS.find((l) => l.value === choice)!;
    let out: WebInviteMade | undefined;
    if (await act.run(async () => { out = await api<WebInviteMade>('invites', { level: c.level, ...(c.layers ? { layers: c.layers } : {}) }); }, 'Invite made: copy its link now')) {
      setMade({ link: inviteLink(out!.token), invite: out!.invite });
      setAgain((n) => n + 1);
    }
  };
  const invites = data?.invites ?? [];
  return (
    <>
      <section className="summary" aria-label="People">
        <h1>Invite people to {overview.kolab.title || me.kolab}</h1>
        <span className="fact">An invite is a link. Whoever signs in with it, as a person, joins {me.kolab} with the access it names, once, within 7 days. It never grants Admin.</span>
      </section>
      <section className="newk" aria-labelledby="p-new">
        <h2 className="section-title" id="p-new">New invite</h2>
        <form onSubmit={make}>
          <div className="field"><label htmlFor="iLevel">Access</label>
            <select id="iLevel" value={choice} onChange={(e) => setChoice(e.target.value)}>{LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</select>
            <span className="hint">An engineer needs Write on the technical layer; a product owner, the functional one.</span></div>
          <div className="edit-row"><button type="submit" className="btn primary">Make an invite link</button></div>
        </form>
        {made && (
          <div className="notice" role="status">
            <h2>Send this link to your teammate</h2>
            <p>It is shown only now. Anyone who holds it can join {me.kolab} with {accessWords(made.invite)} until {new Date(made.invite.expires_at).toLocaleDateString()}, or until it is used or you revoke it.</p>
            <Command label="The invite link" text={made.link} />
          </div>
        )}
      </section>
      <section aria-labelledby="p-list"><h2 className="section-title" id="p-list">Invites</h2>
        {error && <p className="empty" role="alert">{error}</p>}
        {invites.length ? <ul className="qlist">{invites.map((i) => (
          <li key={i.id} className="qitem"><div className="row">
            <Pill tone={i.state === 'open' ? 'question' : i.state === 'accepted' ? 'clean' : 'boundary'}>{i.state}</Pill>
            <span>{accessWords(i)} · by {i.invited_by} · {ago(i.created_at)}{i.accepted_by ? ` · joined by ${i.accepted_by}` : ''}</span>
            {i.state === 'open' && <button type="button" className="btn quiet" onClick={() => act.run(() => api(`invites/${encodeURIComponent(i.id)}/revoke`, {}), 'Invite revoked')}>Revoke</button>}
          </div></li>
        ))}</ul> : <p className="empty">No invites yet.</p>}
      </section>
    </>
  );
}

/** An invite opened from its link (W3.4): what it offers, and joining. */
export function InviteCard({ invite, signedIn, onJoin, onDismiss }: { invite: InvitePreview; signedIn: boolean; onJoin?(): void; onDismiss?(): void }) {
  return (
    <section className="notice" aria-label="Invite">
      <h2>{invite.invited_by} invites you to {invite.title || invite.kolab}</h2>
      <p>Join <span className="addr">{invite.kolab}</span>, owned by {invite.owner}, with {accessWords(invite)}. The invite lasts until {new Date(invite.expires_at).toLocaleDateString()}. Join only if you expected it.</p>
      {signedIn ? (
        <div className="edit-row">
          <button type="button" className="btn primary" onClick={onJoin}>Join {invite.kolab}</button>
          <button type="button" className="btn quiet" onClick={onDismiss}>Not now</button>
        </div>
      ) : <p>Sign in below; Kolab’s sign-in page offers to join it.</p>}
    </section>
  );
}

/** An empty kolab's first page: what to do first, with no admin. */
export function GettingStarted({ me, go }: { me: WebMe; go(r: string): void }) {
  return (
    <section className="notice" aria-label="Getting started">
      <h2>Getting started in {me.kolab}</h2>
      <ol>
        <li><button type="button" className="chip" onClick={() => go('connect')}>Connect a harness</button> over MCP (Claude Code, OpenCode) or with the konjir CLI in a shell.</li>
        {me.access.level === 'admin' && <li><button type="button" className="chip" onClick={() => go('people')}>Invite a teammate</button> with a link: an engineer to write the binding, or a product owner.</li>}
        <li>Write the spec below, or let your agent draft it for you to review.</li>
      </ol>
    </section>
  );
}
