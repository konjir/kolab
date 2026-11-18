/**
 * Waking OpenCode. OpenCode's terminal app serves a small API on this machine (`opencode --port`),
 * through which a prompt can be put in its box and submitted. `konnect agent run <name> opencode`
 * starts it on a port of its own and stays beside it: when a message for the agent arrives, konnect
 * submits the notice (wake.ts: that messages wait, and where, never their words) as a prompt, and
 * the agent's turn starts with nobody typing.
 *
 * Each message is announced once in a session. A notice OpenCode doesn't take (it isn't up yet) is
 * tried again until it does. The notice goes in OpenCode's prompt box, so anything the person has
 * typed there and not sent is sent with it.
 */
import { createServer } from 'node:net';
import { StoredLogin } from '@konjir/login';
import { KolabBridge } from '@konjir/channel-bridge/bridge';
import { listenList } from './agents.js';
import { CLIENT_NAME, TeamClient } from './client.js';
import { unannounced } from './cmd-wake.js';
import { wakeDescriber, type Waking } from './wake.js';

/** A port on this machine that nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

/**
 * OpenCode's own arguments with its port settled: the port the person gave it when they gave a
 * usable one, else `port` put first and any unusable `--port` of theirs taken out, so that konnect
 * and OpenCode always mean the same one.
 */
export function withPort(extra: string[], port: () => Promise<number>): Promise<{ port: number; args: string[] }> {
  const rest: string[] = [];
  let theirs: number | undefined;
  for (let i = 0; i < extra.length; i++) {
    const v = extra[i] === '--port' ? extra[++i] ?? '' : extra[i].startsWith('--port=') ? extra[i].slice('--port='.length) : undefined;
    if (v === undefined) { rest.push(extra[i]); continue; }
    if (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65_536) theirs = Number(v);
  }
  return theirs !== undefined ? Promise.resolve({ port: theirs, args: ['--port', String(theirs), ...rest] }) : port().then((p) => ({ port: p, args: ['--port', String(p), ...rest] }));
}

export interface OpenCodeWake {
  team: string; url: string; file: string; label: string; owner: string; port: number; wakeOn?: string;
  /** How a prompt is put in OpenCode's box, and how the box is submitted; by default its API on this machine. Each resolves false when OpenCode didn't take it. */
  append?: (text: string) => Promise<boolean>;
  submit?: () => Promise<boolean>;
}

const post = (port: number, path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) }).then((r) => r.ok, () => false);

/** Puts `text` in OpenCode's prompt box. False when OpenCode isn't answering. */
export const appendPrompt = (port: number, text: string): Promise<boolean> => post(port, '/tui/append-prompt', { text });

/** Submits what is in OpenCode's prompt box. False when OpenCode isn't answering. */
export const submitPrompt = (port: number): Promise<boolean> => post(port, '/tui/submit-prompt', {});

/**
 * Starts waking the OpenCode that listens on `port` as the agent: resolves with what stops it.
 * Nothing is written anywhere: what was announced is remembered for as long as this runs.
 */
export async function wakeOpenCode(o: OpenCodeWake): Promise<() => Promise<void>> {
  const append = o.append ?? ((text: string) => appendPrompt(o.port, text));
  const submit = o.submit ?? (() => submitPrompt(o.port));
  // Whose login this is, checked before anything is listened to.
  const client = await TeamClient.open(o.team, o.url, o.file, { kind: 'agent', label: o.label, owner: o.owner });
  const actor = client.me.actor;
  await client.close();

  const announced = new Set<string>();
  let last: Waking = { direct: [], woken: [] };
  const fresh = (w: Waking) => (last = unannounced(w, announced));
  // One notice at a time. It is put in the box once, then submitted; each step is tried again, ever
  // more slowly, until OpenCode takes it or this stops: a notice is never dropped, and never put in twice.
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  const until = async (step: () => Promise<boolean>) => {
    for (let wait = 500; !stopped; wait = Math.min(wait * 2, 10_000)) {
      if (await step()) return true;
      await new Promise((r) => { const t = setTimeout(r, wait); (t as { unref?: () => void }).unref?.(); });
    }
    return false;
  };
  const give = (text: string, ids: string[]) => {
    queue = queue.then(async () => {
      if (await until(() => append(text)) && await until(submit)) for (const id of ids) announced.add(id);
    });
  };
  const bridge = new KolabBridge({
    url: o.url, login: new StoredLogin(o.url, { path: o.file, clientName: CLIENT_NAME }), agent: actor,
    catalog: false, channelName: 'konnect', describe: wakeDescriber(new Set(listenList(o.wakeOn)), fresh),
    loginCommand: `konnect agent add ${o.label} (run by the agent's owner)`,
    // Only a message for the agent is given to OpenCode. What the bridge says of its own troubles comes
    // this way too, with nothing new waiting: left unsaid.
    forward: async (m) => {
      const ids = [...last.direct, ...last.woken].map((x) => x.id);
      last = { direct: [], woken: [] };
      if (ids.length) give(m.content, ids);
    },
    // OpenCode owns the terminal: nothing is written to it from here.
    log: () => undefined,
  });
  bridge.start();
  return async () => { stopped = true; await bridge.stop().catch(() => undefined); await Promise.race([queue.catch(() => undefined), new Promise((r) => setTimeout(r, 6_000))]); };
}
