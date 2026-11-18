/**
 * The commands about leases: a named thing in the team (a test database, a port, a file) that one
 * member, a person or an agent, holds at a time, for a while.
 *
 *   konnect lease list
 *   konnect lease claim [--for <time>] [--wait <time>] <name> [<note>...]
 *   konnect lease release <name>
 *   konnect lease break <name>                         a person ends anyone's lease
 *   konnect lease run [--for <time>] [--wait <time>] <name> <command>...
 *
 * A lease lasts 15 minutes unless --for says (1 minute to 4 hours), and claiming your own again
 * renews it. `lease run` holds it while the command runs, renewing it as it goes, and releases it
 * when the command ends. Agents hold leases too: they have the list, claim and release tools.
 */
import { spawn } from 'node:child_process';
import { Refused, type Lease, type TeamClient } from './client.js';
import type { Ctx } from './context.js';
import { UsageError, WaitRanOut } from './errors.js';
import { helpFor } from './help.js';
import { printable, shownActor, type Member } from './names.js';

/** A lease's name, as the service takes one. */
const NAME = /^[A-Za-z0-9._/@:-]{1,200}$/;
/** How long a lease lasts unless told, and the least and most. */
const DEFAULT_S = 900, MIN_S = 60, MAX_S = 14_400;
/** How often a claim that waits looks again. */
const LOOK_EVERY_MS = 2_000;

const leaseName = (given: string | undefined, usage: string): string => {
  if (given === undefined) throw new UsageError(usage);
  if (!NAME.test(given)) throw new UsageError(`${printable(given)} isn't a lease's name: 1 to 200 letters, digits and . _ / @ : -, such as testdb or port-3000`);
  return given;
};

/** --for as seconds, within what a lease may last. */
const seconds = (ctx: Ctx): number | undefined => {
  if (ctx.args.for === undefined) return undefined;
  const s = Math.round(ctx.args.for / 1000);
  if (s < MIN_S || s > MAX_S) throw new UsageError('--for is from 1m to 4h');
  return s;
};

/** `until 14:32 (12 min)`. */
export const until = (l: Lease, now = Date.now()): string => {
  const left = Math.max(0, Math.round((Date.parse(l.expires_at) - now) / 60_000));
  return `until ${l.expires_at.slice(11, 16)} UTC (${left < 1 ? 'under a minute' : `${left} min`})`;
};

const who = (l: Lease, members: Member[]) => `@${printable(shownActor(l.holder, members))}`;

/** One line for each lease: its name, who holds it and until when, and their note. */
export function formatLeases(leases: Lease[], members: Member[], now = Date.now()): string {
  const rows = leases.map((l) => [printable(l.name), who(l, members), until(l, now), l.note ? printable(l.note) : '']);
  const w = [0, 1].map((i) => Math.max(0, ...rows.map((r) => r[i].length)) + 3);
  return rows.map((r) => `${r[0].padEnd(w[0])}${r[1].padEnd(w[1])}${r[2]}${r[3] ? `   ${r[3]}` : ''}`).join('\n');
}

/**
 * Claims the lease, waiting for it when --wait says and someone else holds it. Refused (4) when it
 * is held and nothing says to wait; WaitRanOut (5) when the wait runs out.
 */
async function claim(ctx: Ctx, client: TeamClient, name: string, note: string | undefined): Promise<{ lease: Lease; renewed: boolean }> {
  const held = (l: Lease, members: Member[]) => `${printable(name)} is held by ${who(l, members)} ${until(l)}${l.note ? `: ${printable(l.note)}` : ''}`;
  let waited = 0;
  for (;;) {
    const r = await client.claimLease(name, seconds(ctx), note);
    if (r.claimed) return { lease: r.lease, renewed: !!r.renewed };
    const members = await client.members().catch(() => [] as Member[]);
    if (ctx.args.wait === undefined) throw new Refused(`${held(r.lease, members)}. Wait for it with --wait <time>; a person can end it with konnect lease break ${printable(name)}`);
    if (waited >= ctx.args.wait) throw new WaitRanOut(`${held(r.lease, members)}, and it didn't come free in the time given`);
    const step = Math.min(LOOK_EVERY_MS, ctx.args.wait - waited);
    await ctx.pause(step);
    waited += step;
  }
}

export async function lease(ctx: Ctx, verb: string | undefined, rest: string[]) {
  if (verb === undefined) throw new UsageError(helpFor(['lease']));
  if (!['list', 'claim', 'release', 'break', 'run'].includes(verb)) throw new UsageError(`konnect lease has no ${printable(verb)}: it is list, claim, release, break or run`);
  if (verb === 'break') ctx.personOnly('lease break');
  const team = ctx.team();

  if (verb === 'list') {
    if (rest.length) throw new UsageError(`konnect lease list: unknown ${printable(rest.join(' '))}`);
    const client = await ctx.open(team);
    try {
      const leases = await client.leases();
      const members = ctx.json || !leases.length ? [] : await client.members().catch(() => [] as Member[]);
      ctx.print(leases, () => (leases.length ? formatLeases(leases, members) : `Nothing is held in team ${team}.`));
    } finally { await client.close(); }
    return;
  }

  if (verb === 'claim') {
    const name = leaseName(rest[0], 'konnect lease claim <name> [<note>...]: name what to hold, such as testdb');
    const note = rest.slice(1).join(' ').trim() || undefined;
    if (note && note.length > 200) throw new UsageError('a lease\'s note is at most 200 characters');
    seconds(ctx);
    const client = await ctx.open(team);
    try {
      const r = await claim(ctx, client, name, note);
      ctx.print(r.lease, () => `${r.renewed ? 'Renewed' : 'You hold'} ${printable(name)} ${until(r.lease)}. Give it up with: konnect lease release ${printable(name)}`);
    } finally { await client.close(); }
    return;
  }

  if (verb === 'release' || verb === 'break') {
    const name = leaseName(rest[0], `konnect lease ${verb} <name>: name the lease`);
    if (rest.length > 1) throw new UsageError(`konnect lease ${verb} <name>: unknown ${printable(rest.slice(1).join(' '))}`);
    const client = await ctx.open(team);
    try {
      if (verb === 'release') {
        const r = await client.releaseLease(name).catch((e) => { throw e instanceof Refused ? new Refused(e.message.replace(/kolab (\S+)/g, 'team $1')) : e; });
        ctx.print(r, () => (r.released ? `Released ${printable(name)}.` : `You weren't holding ${printable(name)}.`));
        return;
      }
      const r = await client.breakLease(name);
      const members = ctx.json || !r.lease ? [] : await client.members().catch(() => [] as Member[]);
      ctx.print(r, () => (r.broken && r.lease ? `Ended ${who(r.lease, members)}'s lease on ${printable(name)}.` : `Nobody was holding ${printable(name)}.`));
    } finally { await client.close(); }
    return;
  }

  // run: hold it while the command runs.
  const name = leaseName(rest[0], 'konnect lease run <name> <command>...: name what to hold, then the command to run while holding it');
  const [, cmd, ...args] = rest;
  if (cmd === undefined) throw new UsageError(`konnect lease run ${printable(name)} <command>...: say what to run while holding it`);
  const held = seconds(ctx) ?? DEFAULT_S;
  const client = await ctx.open(team);
  let renewing: ReturnType<typeof setInterval> | undefined;
  // Only a lease this run took is this run's to give up.
  let took = false;
  // A SIGTERM or SIGHUP sent to konnect (a closed terminal, a supervisor stopping it) is passed on to
  // the command, and held off from then until the lease is released: konnect ends by itself, after.
  let stopCommand: ((signal: NodeJS.Signals) => void) | undefined;
  const onTerm = () => stopCommand?.('SIGTERM');
  const onHup = () => stopCommand?.('SIGHUP');
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);
  try {
    const already = new Refused(`you hold ${printable(name)} already, from another konnect lease run or a konnect lease claim, so this command wasn't started: wait for that to end, or konnect lease release ${printable(name)}`);
    // Looked at before it is claimed, so that one this member holds is left exactly as it was: its note and its length too.
    if ((await client.leases()).some((l) => l.name === name && l.holder === client.me.actor)) throw already;
    const first = await claim(ctx, client, name, `running ${cmd}`.slice(0, 200));
    // The service holds a lease for a member, not for a process: one this member holds already (another
    // lease run, or a lease claim) would let two commands run at once, and the first to end would free it under the other.
    if (first.renewed) throw already;
    took = true;
    // Renewed at half its length for as long as the command runs. A lease that is no longer this
    // run's (a person ended it) is said once and never taken back: the command is left running.
    let lost = false;
    renewing = setInterval(() => {
      if (lost) return;
      void client.claimLease(name, held).then(async (r) => {
        if (r.claimed && r.renewed !== false) return;
        lost = true;
        took = false;
        // Ended and free again, this renewal took it afresh: given straight back, as whoever ended it meant.
        if (r.claimed) await client.releaseLease(name).catch(() => undefined);
        ctx.err(`konnect lease run: ${printable(name)} is no longer yours (someone ended the lease): the command is still running`);
      }, () => undefined);
    }, (held * 1000) / 2);
    const code = await (ctx.io.start ?? ((c, dir) => runHolding(c, dir, ctx.env, (stop) => { stopCommand = stop; })))({ cmd, args, env: {} }, ctx.cwd);
    if (code === -1) throw new UsageError(`konnect lease run: there is no ${printable(cmd)} to run`);
    process.exitCode = code;
  } finally {
    clearInterval(renewing);
    if (took) await client.releaseLease(name).catch(() => undefined);
    await client.close();
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  }
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };

/**
 * Runs the command in this terminal and resolves with its exit status (128 + the signal's number
 * when one ended it; -1 when there is no such command). Ctrl-C is the command's to handle.
 * `stopping` is given what passes a signal on to the command while it runs, and nothing once it has ended.
 */
function runHolding(c: { cmd: string; args: string[] }, cwd: string, env: Record<string, string | undefined>, stopping: (stop: ((signal: NodeJS.Signals) => void) | undefined) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(c.cmd, c.args, { cwd, stdio: 'inherit', env: env as NodeJS.ProcessEnv });
    const ignore = () => undefined;
    process.on('SIGINT', ignore);
    stopping((signal) => { child.kill(signal); });
    const done = (code: number) => { stopping(undefined); process.off('SIGINT', ignore); resolve(code); };
    child.on('error', (e) => done((e as { code?: string }).code === 'ENOENT' ? -1 : 1));
    child.on('exit', (code, signal) => done(code ?? 128 + (SIGNALS[signal ?? ''] ?? 0)));
  });
}
