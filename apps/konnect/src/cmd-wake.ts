/**
 * `konnect wake`: plumbing, run by the agent's harness as a hook after each of its turns (Claude
 * Code: a Stop and a SessionStart hook with `asyncRewake`, which `konnect agent run <name> claude`
 * passes on the command line). It waits in the background for a message that wakes the agent, then
 * says so on standard error and exits with status 2, which starts a turn in the idle session.
 *
 * What it says is a notice (wake.ts): that messages wait, and where, never their words. Each
 * message is announced once: what was announced is kept beside the agent's login, so a message the
 * agent left unreceived doesn't wake it again after every turn; a new session of the harness starts
 * afresh, and hears of what an earlier one never received. A newer `konnect wake` for the same agent
 * takes over from an older one, which sees so and ends quietly; so does one whose harness has gone.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StoredLogin } from '@konjir/login';
import { KolabBridge } from '@konjir/channel-bridge/bridge';
import { listenList } from './agents.js';
import { CLIENT_NAME, Refused, SignInError } from './client.js';
import type { Ctx } from './context.js';
import { UsageError, Woke } from './errors.js';
import { agentFile } from './teams.js';
import { wakeDescriber, type Waking } from './wake.js';

/**
 * What is kept between one `konnect wake` and the next: whose turn it is to wait (`claim`, a word
 * only that process knows), the harness session the announcements were made to, and their ids.
 */
interface WakeState { claim?: string; session?: string; announced?: string[] }

/** The most announced ids kept: enough to cover everything unread an agent could be shown. */
const KEPT = 500;
/** How often a waiting process looks whether a newer one has taken over, or its harness has gone. */
const LOOK_EVERY_MS = 3_000;
/** While the service can't be reached as the hook starts, how long between tries: it grows to the second. */
const RETRY_MS = [2_000, 60_000] as const;

const read = (file: string): WakeState => { try { const s = JSON.parse(readFileSync(file, 'utf8')) as WakeState; return s && typeof s === 'object' ? s : {}; } catch { return {}; } };
const write = (file: string, state: WakeState) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
};

/** Where an agent's wake state is kept: beside its login. */
export const wakeFile = (team: string, label: string, env: Record<string, string | undefined>) => join(dirname(agentFile(team, label, env)), `${label}.wake.json`);

/** What of `w` hasn't been announced, by id. */
export function unannounced(w: Waking, announced: ReadonlySet<string>): Waking {
  return { direct: w.direct.filter((m) => !announced.has(m.id)), woken: w.woken.filter((m) => !announced.has(m.id)) };
}

/** What the harness gives its hook on standard input (Claude Code: JSON naming the session), or '' when it gives nothing in time. */
async function hookInput(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let text = '';
    const done = () => { clearTimeout(t); process.stdin.pause(); resolve(text); };
    const t = setTimeout(done, 500);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { text += d; });
    process.stdin.once('end', done);
    process.stdin.once('error', done);
  });
}

export async function wake(ctx: Ctx, rest: string[]): Promise<void> {
  // Exit status 2 with words on standard error is what wakes the harness: nothing but a message
  // for the agent may end this command that way, so its own mistakes are plain failures (1).
  const plain = (e: unknown) => (e instanceof UsageError ? new Error(e.message) : e);
  if (rest.length) throw new Error(`konnect wake: unknown ${rest.join(' ')}`);
  if (ctx.as.kind !== 'agent') throw new Error('konnect wake runs as an agent, from its harness: KONNECT_AGENT names it');
  const { label } = ctx.as;
  let team: string, file: string;
  try { team = ctx.team(); file = ctx.file(team); } catch (e) { throw plain(e); }
  const stateFile = wakeFile(team, label, ctx.env);

  // The harness's session, when it says: what was announced to an earlier session that never
  // received it is this one's to hear.
  let session: string | undefined;
  try { const given = JSON.parse(await (ctx.io.hookInput ?? hookInput)()) as { session_id?: unknown }; if (typeof given?.session_id === 'string') session = given.session_id; } catch { /* none given */ }

  // The newest waits. It takes the claim, and an older process for the same agent, which looks at
  // the claim as it waits, ends by itself: nothing is ever signalled.
  const claim = randomBytes(12).toString('hex');
  const before = read(stateFile);
  const announced = new Set(session !== undefined && before.session !== session ? [] : before.announced ?? []);
  write(stateFile, { claim, ...(session !== undefined ? { session } : {}), announced: [...announced] });
  const mine = () => read(stateFile).claim === claim;
  // A harness that has gone leaves its hook an orphan (the parent is then 1): nobody is there to wake.
  const parent = process.ppid;
  const alone = () => process.ppid !== parent;

  // Whose login this is, checked before anything is listened to. A service that can't be reached
  // just now is tried again: a hook that gave up here would leave the session unwoken until someone typed.
  let actor: string | undefined;
  for (let waitMs: number = RETRY_MS[0]; actor === undefined;) {
    try {
      const client = await ctx.open(team);
      actor = client.me.actor;
      await client.close();
    } catch (e) {
      if (e instanceof SignInError || e instanceof Refused || e instanceof UsageError) throw plain(e);
      await ctx.pause(waitMs);
      if (!mine() || alone()) return;
      waitMs = Math.min(waitMs * 2, RETRY_MS[1]);
    }
  }

  const wakeOn = new Set(listenList(ctx.env.KONNECT_WAKE_ON ?? ctx.env.KONNECT_LISTEN ?? undefined));
  let last: Waking = { direct: [], woken: [] };
  const fresh = (w: Waking) => (last = unannounced(w, announced));

  const notice = await new Promise<string | undefined>((resolve) => {
    const bridge = new KolabBridge({
      url: ctx.url, login: new StoredLogin(ctx.url, { path: file, clientName: CLIENT_NAME }), agent: actor,
      catalog: false, channelName: 'konnect', describe: wakeDescriber(wakeOn, fresh),
      loginCommand: `konnect agent add ${label} (run by the agent's owner)`,
      // Only a message for the agent wakes it. What the bridge says of its own troubles (a login
      // that lapsed, a service it can't reach) comes this way too, with nothing waking: left unsaid.
      forward: async (m) => { if (last.direct.length + last.woken.length) end(m.content); },
      // Standard error is what the agent is shown when it wakes: nothing else is written there.
      log: () => undefined,
    });
    let done = false;
    const end = (said: string | undefined) => {
      if (done) return;
      done = true;
      clearInterval(looking);
      process.off('SIGTERM', quiet);
      process.off('SIGINT', quiet);
      void bridge.stop().catch(() => undefined).then(() => resolve(said));
    };
    const quiet = () => end(undefined);
    const looking = setInterval(() => { if (!mine() || alone()) quiet(); }, LOOK_EVERY_MS);
    process.on('SIGTERM', quiet);
    process.on('SIGINT', quiet);
    (ctx.io.waking ?? (() => undefined))(quiet);
    bridge.start();
  });
  if (notice === undefined) return;
  for (const m of [...last.direct, ...last.woken]) announced.add(m.id);
  // What was announced is kept whoever holds the claim now: a newer process keeps its own claim.
  const now = read(stateFile);
  write(stateFile, { ...(now.claim ? { claim: now.claim } : {}), ...(now.session !== undefined ? { session: now.session } : session !== undefined ? { session } : {}), announced: [...new Set([...(now.session === session ? now.announced ?? [] : []), ...announced])].slice(-KEPT) });
  throw new Woke(notice);
}
