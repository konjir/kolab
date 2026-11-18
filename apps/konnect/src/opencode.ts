/**
 * Waking OpenCode. OpenCode's terminal app serves a small API on this machine (`opencode --port`),
 * through which a prompt can be put in its box and submitted. `konnect agent run <name> opencode`
 * starts it on a port of its own and stays beside it: when a message for the agent arrives, konnect
 * submits the notice (wake.ts: that messages wait, and where, never their words) as a prompt, and
 * the agent's turn starts with nobody typing.
 *
 * Each message is announced once in a session; one that couldn't be submitted (OpenCode not up
 * yet) is tried again at the next change, and what waited as the session started is announced once
 * OpenCode answers.
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

/** The port the person gave OpenCode themselves, among its own arguments, if they did. */
export function givenPort(extra: string[]): number | undefined {
  for (let i = 0; i < extra.length; i++) {
    const v = extra[i] === '--port' ? extra[i + 1] : extra[i].startsWith('--port=') ? extra[i].slice('--port='.length) : undefined;
    if (v !== undefined && /^\d+$/.test(v) && Number(v) > 0) return Number(v);
  }
  return undefined;
}

export interface OpenCodeWake {
  team: string; url: string; file: string; label: string; owner: string; port: number; wakeOn?: string;
  /** How a prompt reaches OpenCode; by default its API on this machine. Resolves false when it couldn't be given. */
  submit?: (text: string) => Promise<boolean>;
  log?: (line: string) => void;
}

/** Puts `text` in OpenCode's prompt box and submits it. False when OpenCode isn't answering. */
export async function submitPrompt(port: number, text: string): Promise<boolean> {
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
  try {
    if (!(await post('/tui/append-prompt', { text })).ok) return false;
    return (await post('/tui/submit-prompt', {})).ok;
  } catch { return false; }
}

/**
 * Starts waking the OpenCode that listens on `port` as the agent: resolves with what stops it.
 * Nothing is written anywhere: what was announced is remembered for as long as this runs.
 */
export async function wakeOpenCode(o: OpenCodeWake): Promise<() => Promise<void>> {
  const submit = o.submit ?? ((text: string) => submitPrompt(o.port, text));
  // Whose login this is, checked before anything is listened to.
  const client = await TeamClient.open(o.team, o.url, o.file, { kind: 'agent', label: o.label, owner: o.owner });
  const actor = client.me.actor;
  await client.close();

  const announced = new Set<string>();
  let last: Waking = { direct: [], woken: [] };
  const fresh = (w: Waking) => (last = unannounced(w, announced));
  // One at a time, and a notice OpenCode didn't take is tried again, a few times, before it is left for the next change.
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  const give = (text: string, ids: string[]) => {
    queue = queue.then(async () => {
      for (let tries = 0; tries < 20 && !stopped; tries++) {
        if (await submit(text)) { for (const id of ids) announced.add(id); return; }
        await new Promise((r) => setTimeout(r, 1_500));
      }
      o.log?.('konnect: OpenCode didn\'t take the notice of new messages; the agent receives them at its next turn');
    });
  };
  const bridge = new KolabBridge({
    url: o.url, login: new StoredLogin(o.url, { path: o.file, clientName: CLIENT_NAME }), agent: actor,
    catalog: false, channelName: 'konnect', describe: wakeDescriber(new Set(listenList(o.wakeOn)), fresh),
    loginCommand: `konnect agent add ${o.label} (run by the agent's owner)`,
    forward: async (m) => { const ids = [...last.direct, ...last.woken].map((x) => x.id); if (ids.length) give(m.content, ids); },
    // OpenCode owns the terminal: nothing is written to it from here.
    log: () => undefined,
  });
  bridge.start();
  return async () => { stopped = true; await bridge.stop().catch(() => undefined); await queue.catch(() => undefined); };
}
