/**
 * `konnect wake`: plumbing, run by the agent's harness as a hook after each of its turns (Claude
 * Code: a Stop and a SessionStart hook with `asyncRewake`, which `konnect agent run <name> claude`
 * passes on the command line). It waits in the background for a message that wakes the agent, then
 * says so on standard error and exits with status 2, which starts a turn in the idle session.
 *
 * What it says is a notice (wake.ts): that messages wait, and where, never their words. Each
 * message is announced once: what was announced is kept beside the agent's login, so a message the
 * agent left unreceived doesn't wake it again after every turn. A newer `konnect wake` for the same
 * agent takes over from an older one, which ends quietly.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StoredLogin } from '@konjir/login';
import { KolabBridge } from '@konjir/channel-bridge/bridge';
import { listenList } from './agents.js';
import { CLIENT_NAME, TeamClient } from './client.js';
import type { Ctx } from './context.js';
import { UsageError, Woke } from './errors.js';
import { agentFile } from './teams.js';
import { wakeDescriber, type Waking } from './wake.js';

/** What is kept between one `konnect wake` and the next: who is waiting, and what was announced. */
interface WakeState { pid?: number; announced?: string[] }

/** The most announced ids kept: enough to cover everything unread an agent could be shown. */
const KEPT = 500;

const read = (file: string): WakeState => { try { return JSON.parse(readFileSync(file, 'utf8')) as WakeState; } catch { return {}; } };
const write = (file: string, state: WakeState) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
};

/** Where an agent's wake state is kept: beside its login. */
export const wakeFile = (team: string, label: string, env: Record<string, string | undefined>) => join(dirname(agentFile(team, label, env)), `${label}.wake.json`);

/** What of `w` hasn't been announced, by id. */
export function unannounced(w: Waking, announced: ReadonlySet<string>): Waking {
  return { direct: w.direct.filter((m) => !announced.has(m.id)), woken: w.woken.filter((m) => !announced.has(m.id)) };
}

export async function wake(ctx: Ctx, rest: string[]): Promise<void> {
  if (rest.length) throw new UsageError(`konnect wake: unknown ${rest.join(' ')}`);
  if (ctx.as.kind !== 'agent') throw new UsageError('konnect wake runs as an agent, from its harness: KONNECT_AGENT names it');
  const { label } = ctx.as;
  const team = ctx.team();
  const file = ctx.file(team);
  const stateFile = wakeFile(team, label, ctx.env);

  // The newest waits; an older one for the same agent is told to end.
  const before = read(stateFile);
  if (before.pid && before.pid !== process.pid) { try { process.kill(before.pid, 'SIGTERM'); } catch { /* gone already */ } }
  const announced = new Set(before.announced ?? []);
  write(stateFile, { pid: process.pid, announced: [...announced] });

  // Whose login this is, checked before anything is listened to.
  const client = await ctx.open(team);
  const actor = client.me.actor;
  await client.close();

  const wakeOn = new Set(listenList(ctx.env.KONNECT_WAKE_ON ?? ctx.env.KONNECT_LISTEN ?? undefined));
  let last: Waking = { direct: [], woken: [] };
  const fresh = (w: Waking) => (last = unannounced(w, announced));

  const notice = await new Promise<string | undefined>((resolve) => {
    const bridge = new KolabBridge({
      url: ctx.url, login: new StoredLogin(ctx.url, { path: file, clientName: CLIENT_NAME }), agent: actor,
      catalog: false, channelName: 'konnect', describe: wakeDescriber(wakeOn, fresh),
      loginCommand: `konnect agent add ${label} (run by the agent's owner)`,
      forward: async (m) => { end(m.content); },
      // Standard error is what the agent is shown when it wakes: nothing else is written there.
      log: () => undefined,
    });
    let done = false;
    const end = (said: string | undefined) => {
      if (done) return;
      done = true;
      process.off('SIGTERM', quiet);
      process.off('SIGINT', quiet);
      void bridge.stop().catch(() => undefined).then(() => resolve(said));
    };
    const quiet = () => end(undefined);
    process.on('SIGTERM', quiet);
    process.on('SIGINT', quiet);
    (ctx.io.waking ?? (() => undefined))(quiet);
    bridge.start();
  });
  if (notice === undefined) return;
  for (const m of [...last.direct, ...last.woken]) announced.add(m.id);
  // Only this process's own claim is cleared: a newer one that took over keeps its own.
  const now = read(stateFile);
  write(stateFile, { ...(now.pid && now.pid !== process.pid ? { pid: now.pid } : {}), announced: [...announced].slice(-KEPT) });
  throw new Woke(notice);
}
