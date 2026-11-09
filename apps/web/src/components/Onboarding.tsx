import { useState, type FormEvent } from 'react';
import type {
  AccessHolder, AccessLevel, AccessSource, InvitePreview, InviteView, KolabAccessView, Layer, OwnSession, WebAccessChanged, WebCli, WebInviteMade, WebInvitesView, WebMe, WebOverview, WebPaged,
  WebSessionRevoked, WebSessionsView, KolabPolicy, PolicySet, PolicyView,
} from '@konjir/types';
import { api } from '../api.js';
import { ago } from '../util.js';
import { Pill } from './bits.js';
import { More, usePaged, useRead } from './Pages.js';
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

/**
 * How to run the konjir CLI here (W3.7): `npx <spec>` only when this Kolab's operator named the
 * published package, pinned to an exact version (KONJIR_CLI_NPM_SPEC). Until then, never `npx
 * konjir`: that name isn't published, and whoever registered it would run code on every machine
 * that pasted the command. A checkout's bin/konjir instead, at ~/kolab.
 */
export const CHECKOUT = '~/kolab';
export const konjirCommand = (cli: WebCli | undefined) => (cli?.npm ? `npx ${cli.npm}` : `${CHECKOUT}/bin/konjir`);

/** `konjir connect` for a harness (W3.7, D59): one agent of yours per entry, product and engineer by default. */
export const konjirConnect = (cli: WebCli | undefined, harness: 'opencode' | 'claude', origin: string, kolab: string) => `${konjirCommand(cli)} connect ${harness} --url ${origin} --kolab ${kolab}`;

/**
 * `konjir connect claude` (W3.8, D61): the Konjir channel bridge, Claude Code's one Konjir server,
 * which runs from a checkout, so always the checkout's konjir, published or not.
 */
export const konjirConnectChannel = (origin: string, kolab: string) => `${CHECKOUT}/bin/konjir connect claude --url ${origin} --kolab ${kolab}`;

/** The agents konjir connect makes by default, by label: `<person>-<label>`, each with its entry `konjir-<label>`. */
export const DEFAULT_AGENT_LABELS = ['product', 'engineer'] as const;
/** Claude Code's server name for an agent's entry, as konjir connect writes it. */
export const entryName = (label: string) => `konjir-${label}`;
/** Starting one agent's Claude Code session with its entry and channel alone, as konjir connect claude ends (W9.1, API24). */
export const claudeSession = (label: string) => `${CHECKOUT}/bin/konjir claude ${label}`;

/** Where the konjir CLI comes from, when it isn't published: a checkout of the repository. */
function GetTheCli({ cli }: { cli: WebCli | undefined }) {
  if (cli?.npm) return <p className="why-not">The konjir CLI is the npm package <span className="mono">{cli.npm}</span>, run with <span className="mono">npx</span> (Node 22 or later).</p>;
  return (
    <>
      <p className="why-not">The konjir CLI isn’t published on npm yet, so these commands run it from a checkout of <span className="mono">github.com/konjir/kolab</span> at <span className="mono">{CHECKOUT}</span> (Node 22 or later). Make the checkout once:</p>
      <Command label="Get the konjir CLI from its repository" text={`git clone https://github.com/konjir/kolab ${CHECKOUT} && (cd ${CHECKOUT} && npm ci)`} />
    </>
  );
}

/**
 * Connecting a harness, by one of two routes. Over MCP (Claude Code, OpenCode, any client that
 * speaks MCP's authorization), the harness needs only the URL and signs in on Kolab's own page,
 * where the person chooses the agent it works as (D30, D56), the kolab and the role; its agent then
 * calls the konjir_instructions tool, since such an agent usually has no konjir CLI. In a shell,
 * the konjir CLI signs in with `konjir login`, and `konjir instructions` gives the same text.
 * `cli` says how this Kolab runs the CLI (GET /api/session/cli).
 */
export function ConnectView({ me, cli, origin = location.origin }: { me: WebMe; cli?: WebCli; origin?: string }) {
  const mcp = `${origin}/mcp`;
  const konjir = konjirCommand(cli);
  return (
    <>
      <section className="summary" aria-label="Connect a harness">
        <h1>Connect a harness</h1>
        <span className="fact">An agent works in Kolab through its own harness, as an agent of yours: its own actor and session, never more access than you. Connect it with one command, over MCP by hand, or through the konjir CLI in a shell.</span>
      </section>
      <section className="newk" aria-labelledby="c-connect">
        <h2 className="section-title" id="c-connect">One command: konjir connect</h2>
        <p className="why-not">Run it in your project. It shows the change to the harness’s config, then opens your browser once, at Kolab’s setup page: it names {me.kolab} and one agent of yours per entry, <span className="mono">{me.actor}-{DEFAULT_AGENT_LABELS[0]}</span> and <span className="mono">{me.actor}-{DEFAULT_AGENT_LABELS[1]}</span> by default, made or reused, each with its role, for you to check and allow. Nothing to choose there, and nothing asked in the terminal. It writes no token in the config.</p>
        <GetTheCli cli={cli} />
        <h3 id="c-connect-opencode">OpenCode</h3>
        <Command label="Connect OpenCode with konjir connect" text={konjirConnect(cli, 'opencode', origin, me.kolab)} />
        <h3 id="c-connect-claude">Claude Code</h3>
        <p className="why-not">For Claude Code, each entry is the Konjir channel: one Konjir server with Kolab’s tools, which also pushes your inbox into the session as it changes, on one sign-in per agent. It runs from a checkout of <span className="mono">github.com/konjir/kolab</span> at <span className="mono">{CHECKOUT}</span>{cli?.npm ? ', so make one first' : ''}, and each agent is signed in at the setup, so no more pages open when Claude Code starts. It prints the command to start Claude Code last.</p>
        {cli?.npm && <Command label="Get the Konjir channel from its repository" text={`git clone https://github.com/konjir/kolab ${CHECKOUT} && (cd ${CHECKOUT} && npm ci)`} />}
        <Command label="Connect Claude Code with konjir connect" text={konjirConnectChannel(origin, me.kolab)} />
        <p className="why-not">Then start each agent’s own Claude Code session in your project, one terminal each, with <span className="mono">konjir claude &lt;label&gt;</span>: only that agent’s entry and channel, and a system prompt naming the agent, its role and kolab, so your prompt to it carries only the task. Channels are a research preview, so it loads as a development channel: choose “I am using this for local development” at the warning. Channels need Claude Code signed in with a claude.ai account; without one the tools still work, and no channel messages arrive.</p>
        {DEFAULT_AGENT_LABELS.map((l) => <Command key={l} label={`Start ${entryName(l)}'s Claude Code session`} text={claudeSession(l)} />)}
        <p className="why-not">Don’t want channels? <span className="mono">--http</span> writes Claude Code’s plain HTTP entry instead, signed in from <span className="mono">/mcp</span>.</p>
        <Command label="Connect Claude Code over HTTP, with no channel" text={`${konjirConnect(cli, 'claude', origin, me.kolab)} --http`} />
        <p className="why-not">Choose the agents with <span className="mono">--agent &lt;label&gt;[:product|engineer]</span>, once for each; <span className="mono">--global</span> writes your own settings rather than the project’s.</p>
      </section>
      <section className="newk" aria-labelledby="c-mcp">
        <h2 className="section-title" id="c-mcp">Over MCP: Claude Code, OpenCode</h2>
        <p className="why-not">Or by hand: add Kolab as an MCP server and sign in. On Kolab’s page, choose the agent it works as (a new one of yours by default), the kolab ({me.kolab}) and its role. Then ask the agent to call <span className="mono">konjir_instructions</span> before its first change: it returns the rules and {me.kolab}’s precedent. No CLI is needed.</p>
        <h3 id="c-claude">Claude Code</h3>
        <p className="why-not">Add it, then run <span className="mono">/mcp</span> in Claude Code and sign in. This entry has no channel; beside the Konjir channel it isn’t needed, and signed in as the same agent the two would end each other’s session (one session each).</p>
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
        {!cli?.npm && <p className="why-not">It runs from the checkout above, at <span className="mono">{CHECKOUT}</span>.</p>}
        <Command label="Sign the konjir CLI in" text={`${konjir} login --url ${mcp} --kolab ${me.kolab} --role ${me.role}`} />
        <Command label="Read the instructions with the konjir CLI" text={`${konjir} instructions`} />
      </section>
      <section className="newk" aria-labelledby="c-work">
        <h2 className="section-title" id="c-work">Put a machine to work: konjir work</h2>
        <p className="why-not">Rather than drive agents yourself, set a machine to work on {me.kolab}: in a checkout of its repository, <span className="mono">konjir work</span> takes what is ready (reviews, work packages, questions and marks on the technical layer) and gives each to an agent of yours in its own worktree, one job at a time per slot. It never merges or deploys. Sign in first, as yourself.</p>
        <Command label="Sign in to put this machine to work" text={`${konjir} login --url ${mcp} --kolab ${me.kolab}`} />
        <Command label="Put this machine to work, in a checkout of the kolab's repository" text={`${konjir} work`} />
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
      <h1 className="section-title" id="p-title">People in {me.kolab}</h1>
      <p className="why-not">Those with Admin in {me.kolab} invite people to it; you hold {accessWords(me.access)}. Ask its owner, {overview.kolab.owner}.</p>
    </section>
  );
}

function Invites({ me, overview, tick, act }: { me: WebMe; overview: WebOverview; tick: number; act: Act }) {
  const [choice, setChoice] = useState('write-technical');
  const [made, setMade] = useState<{ link: string; invite: InviteView }>();
  const [again, setAgain] = useState(0);
  const read = usePaged<WebInvitesView>('invites', tick + again);
  const error = read.error;
  const make = async (e: FormEvent) => {
    e.preventDefault();
    const c = LEVELS.find((l) => l.value === choice)!;
    let out: WebInviteMade | undefined;
    if (await act.run(async () => { out = await api<WebInviteMade>('invites', { level: c.level, ...(c.layers ? { layers: c.layers } : {}) }); }, 'Invite made: copy its link now')) {
      setMade({ link: inviteLink(out!.token), invite: out!.invite });
      setAgain((n) => n + 1);
    }
  };
  const invites = read.pages?.flatMap((p) => p.invites) ?? [];
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
      <AccessList me={me} tick={tick} act={act} />
      <p className="why-not">How far agents act without a person is in <a href="#/settings">Settings</a>.</p>
      <section aria-labelledby="p-list"><h2 className="section-title" id="p-list">Invites</h2>
        {error && <p className="empty" role="alert">{error}</p>}
        {invites.length ? <ul className="qlist">{invites.map((i) => (
          <li key={i.id} className="qitem"><div className="row">
            <Pill tone={i.state === 'open' ? 'question' : i.state === 'accepted' ? 'clean' : 'boundary'}>{i.state}</Pill>
            <span>{accessWords(i)} · by {i.invited_by} · {ago(i.created_at)}{i.accepted_by ? ` · joined by ${i.accepted_by}` : ''}</span>
            {i.state === 'open' && <button type="button" className="btn quiet" onClick={() => act.run(() => api(`invites/${encodeURIComponent(i.id)}/revoke`, {}), 'Invite revoked')}>Revoke</button>}
          </div></li>
        ))}</ul> : <p className="empty">No invites yet.</p>}
        <More more={read.more} busy={read.busy} what="invites" />
      </section>
    </>
  );
}

/**
 * The levels a direct grant may be changed to (W3.6): an invite's, and Admin, which only the kolab's
 * owners give. Kolab refuses anything else: raising an agent's grant (its owner's to do, D56), and
 * lowering a granted Admin unless one owns the kolab or it is one's own.
 */
const GRANT_LEVELS: { value: string; label: string; level: AccessLevel; layers?: Layer[] }[] = [
  ...LEVELS, { value: 'admin', label: 'Admin: also manages who holds access', level: 'admin' },
];

/** Which of GRANT_LEVELS an access is. */
export function levelValue(a: { level: AccessLevel | null; layers: Layer[] }): string {
  if (a.level !== 'write') return a.level ?? '';
  return a.layers.length === 2 ? 'write' : `write-${a.layers[0]}`;
}

/** Where some access comes from, in words. */
export function sourceWords(s: AccessSource, kolab: string, outside: boolean): string {
  switch (s.kind) {
    case 'owner': return `owns ${kolab}: Admin`;
    case 'org_owner': return `an owner of ${s.org}: Admin`;
    case 'base': return `${s.org}'s base permission: ${accessWords(s)}`;
    case 'internal': return `a member of ${s.org}, whose internal kolabs its members read: Read`;
    case 'team': return `team ${s.team}: ${accessWords(s)}`;
    case 'grant': return `${outside ? 'outside collaborator, granted' : 'granted'} ${accessWords(s)}`;
  }
}

/** Where access that isn't a direct grant is changed: never in this page (W3.6). */
export function whereToChange(s: AccessSource, kolab: string): string | undefined {
  switch (s.kind) {
    case 'owner': return `It comes with owning ${kolab}.`;
    case 'org_owner': return `It comes with owning ${s.org}: change it in ${s.org}'s owners.`;
    case 'base': return `Change it in ${s.org}'s base permission for ${kolab}.`;
    case 'internal': return `Change it in ${s.org}'s members, or ${kolab}'s visibility.`;
    case 'team': return `Change it in team ${s.team}'s grant or members.`;
    case 'grant': return undefined;
  }
}

/** The access a choice of GRANT_LEVELS grants. */
const grantAccess = (value: string) => {
  const g = GRANT_LEVELS.find((l) => l.value === value)!;
  return { level: g.level, layers: g.layers ?? (g.level === 'read' || g.level === 'triage' ? [] : ['functional', 'technical'] as Layer[]) };
};

const RANK = ['read', 'triage', 'write', 'maintain', 'admin'];
/** Whether `want` gives anything `current` doesn't: a higher level, or at Write a layer more (as Kolab's own check). */
export function raisesAccess(current: { level: AccessLevel | null; layers: Layer[] }, want: { level: AccessLevel; layers: Layer[] }): boolean {
  return RANK.indexOf(want.level) > RANK.indexOf(current.level ?? '')
    || (want.level === 'write' && current.level === 'write' && want.layers.some((l) => !current.layers.includes(l)));
}

/** The levels a holder's direct grant may be changed to here: for an agent, only its grant or lower, since raising one is its owner's (D56). */
export const grantChoices = (h: Pick<AccessHolder, 'kind' | 'grant'>) =>
  (h.kind === 'agent' && h.grant ? GRANT_LEVELS.filter((l) => !raisesAccess(h.grant!, grantAccess(l.value))) : GRANT_LEVELS);

type Pending = { holder: AccessHolder; remove: true } | { holder: AccessHolder; remove?: false; value: string };

/**
 * Who holds access to the session's kolab (W3.6), for those with Admin there: each person and agent
 * with what they hold and every source of it, and for a direct grant, changing its level or removing
 * it, each confirmed first. Access from owning the kolab, its organization, the base permission or a
 * team is shown, and says where it is changed. Kolab decides each change, under its own rules.
 */
export function AccessList({ me, tick, act }: { me: WebMe; tick: number; act: Act }) {
  const [again, setAgain] = useState(0);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending>();
  // A page of holders at a time (W2.21); the kolab and its teams come with each page.
  const read = usePaged<KolabAccessView & WebPaged>('access', tick + again);
  const error = read.error;
  const data = read.pages && { ...read.pages[0], holders: read.pages.flatMap((p) => p.holders) };
  const kolab = data?.kolab.id ?? me.kolab;
  const confirm = async () => {
    const p = pending!;
    const path = `access/${encodeURIComponent(p.holder.actor)}`;
    const ok = p.remove
      ? await act.run(() => api<WebAccessChanged>(`${path}/remove`, {}), `${p.holder.actor}'s access removed`)
      : await act.run(() => {
        const g = grantAccess(p.value);
        return api<WebAccessChanged>(path, { level: g.level, ...(g.level === 'write' ? { layers: g.layers } : {}) });
      }, `${p.holder.actor}'s access changed`);
    setPending(undefined);
    if (ok) setAgain((n) => n + 1);
  };
  const consequence = (h: AccessHolder) => (h.kind === 'person'
    ? `Their agents hold no more than they do, and any session, theirs or their agents', that can no longer reach ${kolab} ends.`
    : `Its sessions end if it can no longer reach ${kolab}.`);
  return (
    <section aria-labelledby="p-access"><h2 className="section-title" id="p-access">Who holds access</h2>
      <p className="why-not">Here you change or remove a direct grant. Access from owning {kolab}, its organization, a base permission or a team is shown, and changed where it is kept: by the organization's owners, through Konjir's admin for now.{data?.kolab.visibility === 'public' ? ` ${kolab} is public: anyone may read it, so its readers aren't listed.` : ''}</p>
      {error && <p className="empty" role="alert">{error}</p>}
      {pending && (
        <div className="notice" role="alertdialog" aria-labelledby="p-confirm">
          <h2 id="p-confirm">{pending.remove ? `Remove ${pending.holder.actor}'s access?` : `Change ${pending.holder.actor}'s access?`}</h2>
          <p>{pending.remove
            ? `Their direct grant on ${kolab}, ${accessWords(pending.holder.grant!)}, goes. They keep only what reaches them by other routes. `
            : `From ${accessWords(pending.holder.grant!)} to ${accessWords(grantAccess(pending.value))}. `}
          {consequence(pending.holder)}{pending.holder.actor === me.actor ? ' This is your own access: you may lose Admin here.' : ''}</p>
          <div className="edit-row">
            <button type="button" className="btn primary" onClick={() => void confirm()}>{pending.remove ? 'Remove access' : 'Change access'}</button>
            <button type="button" className="btn quiet" onClick={() => setPending(undefined)}>Cancel</button>
          </div>
        </div>
      )}
      {!data && !error && <p className="empty">Reading who holds access…</p>}
      {data && (data.holders.length ? <ul className="qlist" aria-label="People and agents">{data.holders.map((h) => {
        const value = chosen[h.actor] ?? (h.grant ? levelValue(h.grant) : '');
        const elsewhere = h.sources.map((s) => whereToChange(s, kolab)).filter((w): w is string => !!w);
        return (
          <li key={h.actor} className="qitem" aria-label={h.actor}>
            <div className="row">
              <Pill tone={h.access.level ? (h.capped ? 'stale' : 'clean') : 'boundary'}>{accessWords(h.access)}</Pill>
              <span className="mono">{h.actor}</span>
              {h.actor === me.actor && <span>you</span>}
              {h.kind === 'agent' && <span>{h.owner ? `agent of ${h.owner}` : 'an agent whose owner holds nothing here'}{h.owner && h.cap && h.capped ? `, capped at ${accessWords(h.cap)} by what its owner holds` : ''}</span>}
              <span>{h.sources.map((s) => sourceWords(s, kolab, h.outside)).join(' · ')}</span>
            </div>
            {elsewhere.length > 0 && <p className="why-not">{elsewhere.join(' ')}</p>}
            {h.grant && (
              <div className="edit-row">
                <div className="field"><label htmlFor={`g-${h.actor}`}>Grant for {h.actor}</label>
                  <select id={`g-${h.actor}`} value={value} onChange={(e) => setChosen({ ...chosen, [h.actor]: e.target.value })}>
                    {grantChoices(h).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </select></div>
                <button type="button" className="btn" disabled={value === levelValue(h.grant)} onClick={() => setPending({ holder: h, value })}>Change</button>
                <button type="button" className="btn quiet" onClick={() => setPending({ holder: h, remove: true })}>Remove access</button>
              </div>
            )}
          </li>
        );
      })}</ul> : <p className="empty">Nobody holds access yet.</p>)}
      <More more={read.more} busy={read.busy} what="people and agents" />
      {data && data.teams.length > 0 && (
        <>
          <h3 id="p-teams">Teams granted access</h3>
          <ul className="qlist" aria-labelledby="p-teams">{data.teams.map((t) => (
            <li key={t.team} className="qitem"><div className="row">
              <Pill tone="clean">{accessWords(t)}</Pill><span className="mono">{t.team}</span>
              <span>{t.members === 1 ? '1 person' : `${t.members} people`}, its sub-teams' members included</span>
              <span className="why-not">Change it in team {t.team}'s grant or members.</span>
            </div></li>
          ))}</ul>
        </>
      )}
    </section>
  );
}

/** Each setting of a kolab's policy (POL1), in words, with its choices; the first is D103's default for those with choices. */
const POLICY_CHOICES: { key: keyof KolabPolicy; label: string; hint: string; options?: { value: string; label: string }[]; cap?: 'jobs_per_person' | 'jobs_per_kolab' }[] = [
  {
    key: 'approve_functional', label: 'Who approves functional versions', hint: 'Intent is a person\'s: by default a person approves the spec (AUT2).',
    options: [{ value: 'person', label: 'A person' }, { value: 'other_person', label: 'A person other than the one whose intent it carries' }, { value: 'agent', label: 'Anyone with Write, agents included' }],
  },
  {
    key: 'approve_technical', label: 'Who approves technical versions', hint: 'How it\'s built needn\'t be a person\'s: by default an agent may approve bindings (AUT2).',
    options: [{ value: 'agent', label: 'Anyone with Write, agents included' }, { value: 'person', label: 'A person' }, { value: 'other_person', label: 'A person other than the one whose intent it carries' }],
  },
  {
    key: 'approve_work', label: 'Who approves work packages', hint: 'By default an agent reviewer approves work (AUT3).',
    options: [{ value: 'agent', label: 'Anyone with Write on the technical layer, agents included' }, { value: 'person', label: 'A person' }],
  },
  {
    key: 'product_review_of_bindings', label: 'Product review of bindings', hint: 'Whether a binding version also needs a product approval that it doesn\'t change behavior (VER13).',
    options: [{ value: 'false', label: 'Not required' }, { value: 'true', label: 'Required' }],
  },
  {
    key: 'answer_functional', label: 'Who answers questions on the functional layer', hint: 'Agents don\'t invent intent: by default an agent answers only by citing committed elements or rulings (AUT4).',
    options: [{ value: 'agent_cited', label: 'An agent citing its source, or a person' }, { value: 'person', label: 'Only a person' }],
  },
  { key: 'jobs_per_person', label: 'Jobs a person runs at once', hint: 'AUT7: never above the server\'s own limit.', cap: 'jobs_per_person' },
  { key: 'jobs_per_kolab', label: 'Jobs the kolab runs at once', hint: 'AUT7: never above the server\'s own limit.', cap: 'jobs_per_kolab' },
];

/**
 * The kolab's autonomy policy (W6.2; AUT1, POL2): for those with Admin there, from their own
 * session. Each setting with its value, and changing any of them at once. Kolab decides each change,
 * which takes effect at once and is recorded with who made it; rulings and registering a repository
 * stay a person's whatever it says (AUT5).
 */
export function PolicySettings({ me, tick, act }: { me: WebMe; tick: number; act: Act }) {
  const [again, setAgain] = useState(0);
  const [chosen, setChosen] = useState<Partial<Record<keyof KolabPolicy, string>>>({});
  const read = useRead<PolicyView>('policy', tick + again);
  const error = read.error;
  // Only a policy as Kolab gives it is shown.
  const data = read.data?.policy ? read.data : undefined;
  const valueOf = (k: keyof KolabPolicy) => chosen[k] ?? (data ? String(data.policy[k]) : '');
  const changes = data ? POLICY_CHOICES.filter((c) => chosen[c.key] !== undefined && chosen[c.key] !== String(data.policy[c.key])) : [];
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const c of changes) {
      const v = chosen[c.key]!;
      body[c.key] = c.cap ? Number(v) : c.key === 'product_review_of_bindings' ? v === 'true' : v;
    }
    if (await act.run(() => api<PolicySet>('policy', body), 'Policy changed: it takes effect at once')) {
      setChosen({});
      setAgain((n) => n + 1);
    }
  };
  return (
    <section aria-labelledby="p-policy"><h2 className="section-title" id="p-policy">Kolab settings: how far agents act without a person</h2>
      <p className="why-not">The policy of {me.kolab} (AUT1). Kolab enforces it where each act happens; anything it keeps for a person waits for one. Rulings and registering a repository are always a person's.</p>
      {error && <p className="empty" role="alert">{error}</p>}
      {!data && !error && <p className="empty">Reading the policy…</p>}
      {data && (
        <form onSubmit={save} aria-label="Policy">
          {POLICY_CHOICES.map((c) => (
            <div key={c.key} className="field">
              <label htmlFor={`pol-${c.key}`}>{c.label}</label>
              {c.options ? (
                <select id={`pol-${c.key}`} value={valueOf(c.key)} onChange={(e) => setChosen({ ...chosen, [c.key]: e.target.value })}>
                  {c.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input id={`pol-${c.key}`} type="number" min={1} max={data.limits[c.cap!]} value={valueOf(c.key)} onChange={(e) => setChosen({ ...chosen, [c.key]: e.target.value })} />
              )}
              <span className="hint">{c.hint}{c.cap ? ` At most ${data.limits[c.cap]}.` : ''}{data.changed_from_default.includes(c.key) ? ' Changed from the default.' : ''}</span>
            </div>
          ))}
          <div className="edit-row">
            <button type="submit" className="btn primary" disabled={!changes.length}>Change {changes.length === 1 ? 'this setting' : 'these settings'}</button>
            {changes.length > 0 && <button type="button" className="btn quiet" onClick={() => setChosen({})}>Cancel</button>}
            <span className="why-not">{data.updated_by ? `Last changed by ${data.updated_by} ${ago(data.updated_at!)}.` : 'Every setting has its default.'}</span>
          </div>
        </form>
      )}
    </section>
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

const VIA_WORDS: Record<OwnSession['via'], string> = { web: 'web page', app: 'app', token: 'token' };

/**
 * Your sessions (W6.1, D103): you hold one on each machine you sign in through as yourself, each
 * konjir install, browser and harness entry, and signing in again on one replaces only that one.
 * The list says where and when each was last used; revoking one ends it at once and closes its
 * streams (D41). This browser's own is marked, and signing out ends it instead.
 */
export function SessionsView({ tick, act }: { tick: number; act: Act }) {
  const [again, setAgain] = useState(0);
  const { data, error } = useRead<WebSessionsView>('sessions', tick + again);
  const [pending, setPending] = useState<OwnSession>();
  const revoke = async (s: OwnSession) => {
    setPending(undefined);
    if (await act.run(() => api<WebSessionRevoked>(`sessions/${encodeURIComponent(s.session)}/revoke`, {}), `Revoked: ${s.where} is signed out`)) setAgain((n) => n + 1);
  };
  const sessions = data?.sessions ?? [];
  return (
    <>
      <section className="summary" aria-label="Your sessions">
        <h1>Your sessions</h1>
        <span className="fact">You stay signed in on each machine you use: each konjir install, browser and harness. Signing in again on one replaces only that one. Revoke any you no longer use.</span>
      </section>
      <section aria-labelledby="s-list"><h2 className="section-title" id="s-list">Signed in now</h2>
        {error && <p className="empty" role="alert">{error}</p>}
        {pending && (
          <div className="notice" role="alertdialog" aria-labelledby="s-confirm">
            <h2 id="s-confirm">Revoke {pending.where}?</h2>
            <p>It is signed out at once, wherever it is, and anything it runs stops. Signing in there again opens a new session.</p>
            <div className="edit-row">
              <button type="button" className="btn primary" onClick={() => void revoke(pending)}>Revoke</button>
              <button type="button" className="btn quiet" onClick={() => setPending(undefined)}>Keep it</button>
            </div>
          </div>
        )}
        {sessions.length ? <ul className="qlist">{sessions.map((s) => (
          <li key={s.session} className="qitem" aria-label={`${s.where}, ${s.session.slice(0, 8)}`}><div className="row">
            <Pill tone={s.current ? 'clean' : 'question'}>{s.current ? 'this browser' : VIA_WORDS[s.via]}</Pill>
            <span><b>{s.where}</b> · {s.kolab} as {s.role} · last used {ago(s.last_used)} · opened {ago(s.started_at)}
              {s.expires_at ? ` · expires ${new Date(s.expires_at).toLocaleDateString()}` : ''} · <span className="mono" title={s.session}>{s.session.slice(0, 8)}</span></span>
            {!s.current && <button type="button" className="btn quiet" onClick={() => setPending(s)}>Revoke</button>}
          </div></li>
        ))}</ul> : !error && data ? <p className="empty">No open sessions.</p> : null}
      </section>
    </>
  );
}

/** Connect a harness, with how this Kolab runs the konjir CLI (W3.7): a checkout's until the server names a published spec. */
export function ConnectPage({ me }: { me: WebMe }) {
  const { data } = useRead<WebCli>('session/cli', 0);
  return <ConnectView me={me} cli={data} />;
}
