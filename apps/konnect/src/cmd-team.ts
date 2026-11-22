/**
 * The commands about channels, about the team and who is in it, and about being logged in:
 *
 *   konnect channel list | create <name> | follow <name> | unfollow <name>
 *   konnect team list | create <name> | invite <github-user>... | remove <person> | leave <team>
 *               | archive <team> | delete <team> --yes
 *   konnect login [<team>]
 *   konnect logout [<team>]
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logout } from '@konjir/login';
import { Refused, said, type Invitation } from './client.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { helpFor } from './help.js';
import { channelName, formatChannels, formatTeam, memberJson, printable, shownName, storedName, type Member } from './names.js';
import { joinTeam, signInToTeam } from './sign-in.js';
import { agentFile, checkTeam, dropIfEmpty, teamFile, teamsAt } from './teams.js';

const one = (rest: string[], usage: string): string => {
  if (rest.length !== 1) throw new UsageError(usage);
  return rest[0];
};

// ---- channels --------------------------------------------------------------------------------

export async function channel(ctx: Ctx, verb: string | undefined, rest: string[]) {
  if (verb === undefined) throw new UsageError(helpFor(['channel']));
  if (!['list', 'create', 'follow', 'unfollow'].includes(verb)) throw new UsageError(`konnect channel has no ${printable(verb)}: it is list, create, follow or unfollow`);
  if (verb === 'list') {
    if (rest.length) throw new UsageError(`konnect channel list: unknown ${printable(rest.join(' '))}`);
    const client = await ctx.open();
    try {
      const channels = await client.channels();
      ctx.print(channels, () => (channels.length ? formatChannels(channels) : 'No channels.'));
    } finally { await client.close(); }
    return;
  }
  ctx.personOnly(`channel ${verb}`);
  let name: string;
  try { name = channelName(one(rest, `konnect channel ${verb} <name>: name one channel`)); } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
  const client = await ctx.open();
  try {
    if (verb === 'create') {
      const made = await client.makeChannel(name);
      ctx.print(made, () => `Created #${made.channel}. You follow it, and everyone in the team can read it and send to it.`);
    } else if (verb === 'follow') {
      const r = await client.follow(name);
      ctx.print(r, () => `Following #${r.channel}: konnect receive includes it from now on.`);
    } else {
      const r = await client.unfollow(name);
      ctx.print(r, () => `No longer following #${r.channel}. A message there that mentions you still reaches you.`);
    }
  } finally { await client.close(); }
}

// ---- the team --------------------------------------------------------------------------------

/** The server's words for what only the team's owner may do, as konnect says them. */
const ownerOnly = (team: string) => (e: unknown) => {
  if (e instanceof Refused && /only the owner of kolab \S+ can (archive|erase) it/.test(e.message)) return new Refused(`only team ${team}'s owner can ${/archive/.test(e.message) ? 'archive' : 'delete'} it`);
  if (e instanceof Refused && /only the owner of kolab/.test(e.message)) return new Refused(`only team ${team}'s owner can do that: ask them`);
  if (e instanceof Refused && /you own kolab \S+, so you can't leave it/.test(e.message)) return new Refused(`you own team ${team}, so you can't leave it: konnect team archive ${team} closes it, or konnect team delete ${team} deletes it`);
  if (e instanceof Refused && /holds documents, so it can't be erased/.test(e.message)) return new Refused(`team ${team} holds documents, so it can't be deleted: konnect team archive ${team} closes it and keeps them`);
  return e;
};

export async function team(ctx: Ctx, verb: string | undefined, rest: string[]) {
  if (verb === undefined) throw new UsageError(helpFor(['team']));
  if (!['list', 'create', 'invite', 'remove', 'leave', 'archive', 'delete'].includes(verb)) {
    // 0.1.0's `konnect team <name>` signed in to a team, creating it when the name was free.
    throw new UsageError(`konnect team has no ${printable(verb)}: it is list, create, invite, remove, leave, archive or delete. To log in to a team: konnect login ${printable(verb)}. To create one: konnect team create ${printable(verb)}`);
  }

  if (verb === 'list') {
    if (rest.length) throw new UsageError(`konnect team list: unknown ${printable(rest.join(' '))}`);
    const client = await ctx.open();
    try {
      const members = await client.members();
      // Who is invited is the owner's to see: anyone else is refused, and shown the members alone.
      const invited: Invitation[] | undefined = ctx.as.kind === 'person' ? await client.invitations().catch(() => undefined) : undefined;
      ctx.print({ members: members.map(memberJson), ...(invited ? { invited: invited.map((i) => ({ account: i.account, invited_by: i.invited_by, invited_at: i.created_at })) } : {}) },
        () => formatTeam(members, invited ?? []));
    } finally { await client.close(); }
    return;
  }

  ctx.personOnly(`team ${verb}`);

  if (verb === 'create') {
    const name = checkName(one(rest, 'konnect team create <name>: name the team'));
    if (teamsAt(ctx.url, ctx.env).includes(name)) throw new Refused(`you're already logged in to a team named ${name}: pick another name`);
    ctx.needsTerminal('konnect team create');
    const { me } = await signInToTeam(name, ctx.url, { open: ctx.io.open, log: ctx.err, env: ctx.env }, 'create');
    ctx.print({ team: name, name: me.actor, created: true }, () => `Created team ${name}, with you (@${printable(me.actor)}) as its owner, and logged in to it.\nInvite people with: konnect${teamsAt(ctx.url, ctx.env).length > 1 ? ` --team ${name}` : ''} team invite <github-user>`);
    return;
  }

  if (verb === 'leave' || verb === 'archive' || verb === 'delete') {
    // The team is named, never resolved: nobody leaves, archives or deletes the wrong team by where they happen to stand.
    const name = checkName(one(rest, `konnect team ${verb} <team>: name the team to ${verb}`));
    if (ctx.args.team !== undefined && ctx.args.team !== name) throw new UsageError(`konnect team ${verb} ${name} was given --team ${printable(ctx.args.team)}: name the team once`);
    if (verb === 'delete' && !ctx.args.yes) {
      throw new UsageError(`konnect team delete ${name} deletes team ${name} and everything in it, for everyone, and it can't be undone: its messages and channels, who is in it and invited, its leases and its machines that host. Everyone in it is logged out of it.\nTo delete it: konnect team delete ${name} --yes\nTo close it and keep everything instead: konnect team archive ${name}`);
    }
    const client = await ctx.openAsPerson(name);
    let r;
    try {
      r = await (verb === 'leave' ? client.leave() : verb === 'archive' ? client.archiveTeam(name) : client.deleteTeam(name)).catch((e) => { throw ownerOnly(name)(e); });
    } finally { await client.close(); }
    await logout(ctx.url, { path: teamFile(name, ctx.env), forget: true }).catch(() => undefined);
    // Its agents' logins are revoked with it: what konnect kept of them here, for this service, goes too.
    const kept = dirname(agentFile(name, 'x', ctx.env));
    let files: string[] = [];
    try { files = readdirSync(kept).filter((f) => f.endsWith('.json')); } catch { /* none kept */ }
    for (const f of files) { await logout(ctx.url, { path: join(kept, f), forget: true }).catch(() => undefined); dropIfEmpty(join(kept, f)); }
    if ('left' in r) {
      const left = r;
      ctx.print(left, () => `You left team ${name}${left.agents.length ? `, and your agents ${left.agents.map(printable).join(', ')} with you` : ''}. konnect dropped its logins to it here.`);
    } else if ('archived' in r) {
      const a = r;
      ctx.print({ team: name, archived: true, ended: a.ended }, () => `Archived team ${name}: nobody can use it now, and everything in it is kept. ${a.ended} session${a.ended === 1 ? '' : 's'} ended. A Konjir admin can unarchive it. konnect dropped its logins to it here.`);
    } else {
      const d = r;
      ctx.print({ team: name, deleted: true, ended: d.ended, revoked: d.revoked, messages: d.messages }, () => `Deleted team ${name} and everything in it (${d.messages} message${d.messages === 1 ? '' : 's'}). ${d.ended} session${d.ended === 1 ? '' : 's'} ended, and its name is free again. konnect dropped its logins to it here.`);
    }
    return;
  }

  const name = ctx.team();
  if (verb === 'invite') {
    if (!rest.length) throw new UsageError('konnect team invite <github-user>...: name who to invite');
    const client = await ctx.open(name);
    try {
      const r = await client.invite(rest.map((w) => w.replace(/^@/, ''))).catch((e) => { throw ownerOnly(name)(e); });
      ctx.print(r, () => [
        ...(r.invited.length ? [`Invited: ${r.invited.map((i) => printable(i.account)).join(', ')}.`] : []),
        ...(r.already_invited.length ? [`Already invited: ${r.already_invited.map((i) => printable(i.account)).join(', ')}.`] : []),
        ...(r.already_members.length ? [`Already in the team: ${r.already_members.map(printable).join(', ')}.`] : []),
        ...(r.declined_recently.length ? [`Declined in the last 30 days, so not asked again yet: ${r.declined_recently.map(printable).join(', ')}.`] : []),
        ...(r.invited.length || r.already_invited.length ? ['They join by running, with the GitHub account you named:', '  npx @konjir/konnect login'] : []),
      ].join('\n'));
    } finally { await client.close(); }
    return;
  }

  // remove: a person and their agents, or, when they were invited and haven't answered, the invitation.
  const who = one(rest, 'konnect team remove <person>: name one person').replace(/^@/, '');
  if (who.includes('/')) throw new UsageError(`konnect team remove takes a person, and ${printable(who)} is an agent: its owner removes it with konnect agent remove ${printable(who.slice(who.indexOf('/') + 1))}`);
  const client = await ctx.open(name);
  try {
    const waiting = (await client.invitations().catch((e) => { throw ownerOnly(name)(e); })).find((i) => i.account.toLowerCase() === who.toLowerCase());
    if (waiting) {
      const w = await client.withdraw(waiting.id);
      ctx.print({ withdrawn: w }, () => `Withdrew ${printable(waiting.account)}'s invitation to team ${name}.`);
      return;
    }
    let stored: string;
    try { stored = storedName(who); } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
    const r = await client.removeMember(stored).catch((e) => { throw ownerOnly(name)(e); });
    ctx.print(r, () => `Removed @${printable(r.removed)} from team ${name}${r.agents.length ? `, with their agents ${r.agents.map(printable).join(', ')}` : ''}: ${r.ended} session${r.ended === 1 ? '' : 's'} ended.`);
  } finally { await client.close(); }
}

const checkName = (name: string) => {
  try { return checkTeam(name); } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
};

// ---- logging in --------------------------------------------------------------------------------

export async function login(ctx: Ctx, rest: string[]) {
  ctx.personOnly('login');
  if (rest.length > 1) throw new UsageError(`konnect login [<team>]: unknown ${printable(rest.slice(1).join(' '))}`);
  if (rest[0] !== undefined && ctx.args.team !== undefined && rest[0] !== ctx.args.team) throw new UsageError(`konnect login ${printable(rest[0])} was given --team ${printable(ctx.args.team)}: name the team once`);
  const given = rest[0] ?? ctx.args.team;
  const sign = { open: ctx.io.open, log: ctx.err, env: ctx.env };
  if (given !== undefined) {
    const name = checkName(given);
    if (!teamsAt(ctx.url, ctx.env).includes(name)) ctx.needsTerminal('konnect login');
    const { me, fresh } = await signInToTeam(name, ctx.url, sign, 'join');
    ctx.print({ team: name, name: me.actor, logged_in: fresh ? 'now' : 'already' }, () => `${fresh ? 'Logged in' : 'Already logged in'} to team ${name} as @${printable(me.actor)}.`);
    return;
  }
  ctx.needsTerminal('konnect login');
  const r = await joinTeam(ctx.url, sign);
  const client = await ctx.openAsPerson(r.team);
  try {
    const members = await client.members().catch(() => [] as Member[]);
    const several = teamsAt(ctx.url, ctx.env).length > 1;
    const k = `konnect${several ? ` --team ${r.team}` : ''}`;
    ctx.print({ team: r.team, name: r.actor, members: members.map(memberJson) }, () => [
      `You're in team ${r.team}, as @${printable(r.actor)}.`,
      ...(members.length ? ['', formatTeam(members, []), ''] : ['']),
      'Next:',
      `  ${k} status                      what is waiting for you`,
      `  ${k} send '#general' "hello"     say hello to the team`,
      `  ${k} agent run <name> claude     bring an agent of yours into the team`,
      ...(several ? ['', `You are logged in to several teams: name one with --team, or set KONNECT_TEAM=${r.team}.`] : []),
    ].join('\n'));
  } finally { await client.close(); }
}

export async function logOut(ctx: Ctx, rest: string[]) {
  ctx.personOnly('logout');
  if (rest.length > 1) throw new UsageError(`konnect logout [<team>]: unknown ${printable(rest.slice(1).join(' '))}`);
  if (rest[0] !== undefined && ctx.args.team !== undefined && rest[0] !== ctx.args.team) throw new UsageError(`konnect logout ${printable(rest[0])} was given --team ${printable(ctx.args.team)}: name the team once`);
  const name = rest[0] !== undefined ? checkName(rest[0]) : ctx.team();
  const command = `konnect logout ${name}`;
  // logout's own refusal names this command, and says the login is kept and how to drop it: said as it is.
  const r = await logout(ctx.url, { path: teamFile(name, ctx.env), forget: ctx.args.forget, command }).catch((e: unknown) => {
    throw String((e as Error)?.message ?? e).includes(`${command} --forget`) ? e : said(e, name, ctx.url);
  });
  ctx.print({ team: name, had: r.had, revoked: r.revoked }, () => (!r.had ? `You weren't logged in to team ${name}.`
    : r.revoked ? `Logged out of team ${name}.` : `Logged out of team ${name} here; the service couldn't be told, so the login lapses within 30 days unused.`));
}

