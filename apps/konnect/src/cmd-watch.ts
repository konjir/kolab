/**
 * `konnect watch [<from>]`: prints messages as they arrive, until it is interrupted. It changes
 * nothing: what was unread stays unread, for `konnect receive` (or an agent's konnect_receive).
 *
 * With no <from>: your direct messages, and every channel you follow. With '#channel' or @member:
 * that one alone. It holds one subscription to the session's answers, which the service pushes on
 * every change, and reads what is new from the history of the place that changed, so nothing is
 * missed however much is unread there. --json prints one JSON object a line.
 */
import { StoredLogin } from '@konjir/login';
import { KolabBridge } from '@konjir/channel-bridge/bridge';
import { isAnswers, type AnswersBody } from '@konjir/channel-bridge/messages';
import { targetOf, type Target } from './chat.js';
import { CLIENT_NAME, type TeamClient } from './client.js';
import type { Ctx } from './context.js';
import { UsageError } from './errors.js';
import { formatMessage, printable, type Member } from './names.js';

/** How far back one look reads: more than arrives between two pushes. */
const LOOK = 50;

export async function watch(ctx: Ctx, rest: string[]): Promise<void> {
  if (rest.length > 1) throw new UsageError(`konnect watch [<from>]: unknown ${printable(rest.slice(1).join(' '))}`);
  let from: Target | undefined;
  if (rest[0] !== undefined) {
    try { from = targetOf(rest[0], (w) => `konnect watch @${w} for a member, or konnect watch '#${w}' for a channel`); } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
  }
  const team = ctx.team();
  const client: TeamClient = await ctx.open(team);
  try {
    const me = client.me.actor;
    const members = ctx.json ? [] : await client.members().catch(() => [] as Member[]);
    // Where each place stands as watching starts: only what comes after is printed.
    const last = new Map<string, string>();
    const channels = from?.kind === 'channel' ? [from.channel] : from ? [] : (await client.channels()).filter((c) => c.following).map((c) => c.channel);
    for (const c of channels) last.set(`#${c}`, (await client.channelHistory(c, 1))[0]?.id ?? '');
    const direct = !from || from.kind === 'direct';
    if (direct) last.set('@', (await client.directRecent(1))[0]?.id ?? '');

    let shown: string | undefined;
    const print = (place: string, m: { id: string; from: string; message: string; sent_at: string }, more: Record<string, unknown>) => {
      if (ctx.json) { ctx.out(JSON.stringify({ ...more, ...m })); return; }
      ctx.out(`${shown === undefined ? '' : '\n'}${shown === place ? '' : `${place}\n`}${formatMessage(m, members)}`);
      shown = place;
    };
    const lookAt = async (channel: string) => {
      const key = `#${channel}`;
      const since = last.get(key) ?? '';
      const fresh = (await client.channelHistory(channel, LOOK)).filter((m) => m.id > since).reverse();
      for (const m of fresh) print(key, m, { channel });
      if (fresh.length) last.set(key, fresh.at(-1)!.id);
    };
    const lookDirect = async () => {
      const since = last.get('@') ?? '';
      const all = (await client.directRecent(LOOK)).filter((m) => m.id > since).reverse();
      // What came to you, from the member watched when one is named: what you sent isn't news to you.
      for (const m of all.filter((x) => x.to === me && (from?.kind !== 'direct' || x.from === from.to))) print(`Direct, from @${printable(m.from)}`, m, { direct: true });
      if (all.length) last.set('@', all.at(-1)!.id);
    };

    // One look at a time, in the order the pushes came; a look that fails is said, and the next still runs.
    let queue: Promise<void> = Promise.resolve();
    const changed = (before: AnswersBody | undefined, after: AnswersBody) => {
      const was = new Map((before?.channels ?? []).map((c) => [c.channel, `${c.unread}/${(c.items ?? []).at(-1)?.id}`]));
      const places: (() => Promise<void>)[] = [];
      for (const c of after.channels ?? []) {
        const scoped = last.has(`#${c.channel}`);
        if (scoped && (before === undefined || was.get(c.channel) !== `${c.unread}/${(c.items ?? []).at(-1)?.id}`)) places.push(() => lookAt(c.channel));
      }
      if (direct && (before === undefined || before.messages?.unread !== after.messages?.unread || (before.messages?.items ?? []).at(-1)?.id !== (after.messages?.items ?? []).at(-1)?.id)) places.push(lookDirect);
      for (const look of places) queue = queue.then(look).catch((e: unknown) => ctx.err(`konnect watch: ${(e as Error)?.message ?? e}`));
    };

    if (!ctx.json) ctx.err(`Watching ${from ? (from.kind === 'channel' ? `#${from.channel}` : printable(from.given)) : `team ${team}`} as @${printable(me)}. Nothing is marked as received. Ctrl-C ends it.`);
    await new Promise<void>((resolve) => {
      const bridge = new KolabBridge({
        url: ctx.url, login: new StoredLogin(ctx.url, { path: ctx.file(team), clientName: CLIENT_NAME }), agent: me,
        catalog: false, channelName: 'konnect',
        describe: {
          change(uri: string, before: unknown, after: unknown) { if (uri.startsWith('konjir://answers/') && isAnswers(after)) changed(isAnswers(before) ? before : undefined, after); return null; },
          // What waited as watching started stays for receive: only what comes after is printed.
          startup() { return null; },
        },
        loginCommand: 'konnect login',
        forward: async () => undefined,
        log: () => undefined,
      });
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        process.off('SIGINT', end);
        process.off('SIGTERM', end);
        void bridge.stop().catch(() => undefined).then(() => queue).then(() => resolve());
      };
      process.on('SIGINT', end);
      process.on('SIGTERM', end);
      (ctx.io.waking ?? (() => undefined))(end);
      bridge.start();
    });
  } finally { await client.close(); }
}
