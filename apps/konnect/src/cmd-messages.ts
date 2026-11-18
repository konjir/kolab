/**
 * The commands about messages, and about what waits for you:
 *
 *   konnect status                  what is unread; changes nothing
 *   konnect send <to> [<message>]   to a channel or a member
 *   konnect receive [<from>]        your unread, oldest first; then no longer unread
 *   konnect history <of>            recent messages; changes nothing
 */
import { NotYet, Refused, type TeamClient } from './client.js';
import { leftAfter, readAll, readOne, send, targetOf, type Block, type Sent, type Target } from './chat.js';
import type { Ctx } from './context.js';
import { UsageError, WaitRanOut } from './errors.js';
import { counted, formatMessage, printable, shownActor, shownName, unreadLine, type Member } from './names.js';

/** How many `receive` and `history` give unless told. */
export const AT_ONCE = 20;
/** How often `--wait` looks for a message. */
const LOOK_EVERY_MS = 2_000;

async function readStdin(): Promise<string> {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const noMore = (rest: string[], usage: string) => { if (rest.length) throw new UsageError(`${usage}: unknown ${printable(rest.join(' '))}`); };

export async function status(ctx: Ctx, rest: string[]) {
  noMore(rest, 'konnect status');
  const team = ctx.team();
  const client = await ctx.open(team);
  try {
    const u = await client.unread();
    const name = shownName(client.me);
    const waiting = u.channels.filter((c) => (c.following && c.unread) || c.mentions);
    ctx.print({ team, name, direct: u.direct, direct_more: u.directMore, channels: waiting }, () => {
      const rows: [string, string][] = [];
      if (u.direct) rows.push(['direct messages', `${counted(u.direct, u.directMore)} unread`]);
      for (const c of waiting) {
        rows.push([`#${printable(c.channel)}`, [
          ...(c.following && c.unread ? [`${counted(c.unread, c.unread_more)} unread`] : []),
          ...(c.mentions ? [`${counted(c.mentions, c.mentions_more)} mentioning you`] : []),
        ].join(', ')]);
      }
      const width = Math.max(0, ...rows.map((r) => r[0].length)) + 3;
      return [`${team}, as @${printable(name)}`, '', ...(rows.length ? rows.map((r) => `  ${r[0].padEnd(width)}${r[1]}`) : ['  Nothing unread.'])].join('\n');
    });
  } finally { await client.close(); }
}

export async function sendMessage(ctx: Ctx, rest: string[]) {
  const [where, ...words] = rest;
  if (where === undefined) throw new UsageError('konnect send <to> [<message>]: say where it goes, \'#channel\' or @member');
  const to = target(where, 'send');
  let message = words.join(' ');
  if (!words.length) {
    if (!ctx.io.stdin && process.stdin.isTTY) ctx.err('Type your message, then press Ctrl-D on a line of its own.');
    message = (await (ctx.io.stdin ?? readStdin)()).replace(/\r?\n$/, '');
  }
  if (!message.trim()) throw new UsageError('konnect send: the message is empty');
  const team = ctx.team();
  const client = await ctx.open(team);
  try {
    let r: Sent;
    try {
      r = await send(client, to, message, { replyTo: ctx.args.reply, warn: ctx.err });
    } catch (e) {
      if (e instanceof Refused && to.kind === 'direct' && /is not a member of kolab/.test(e.message)) throw new Refused(`${printable(to.given)} isn't in team ${team}: konnect team list shows who is`);
      throw e;
    }
    // An agent either has a session open or it doesn't, and the sender should know which.
    const agent = r.kind === 'direct' && to.kind === 'direct' && to.given.includes('/')
      ? (await client.members().catch(() => [] as Member[])).find((m) => m.actor === to.to)
      : undefined;
    ctx.print(r.sent, () => {
      if (r.kind === 'direct') {
        const given = printable(to.kind === 'direct' ? to.given : '');
        if (!agent) return `Sent to ${given}.`;
        // The service calls an agent connected while its login is open, whether or not its harness is running:
        // only the lack of one is certain, so only that is said.
        return agent.here ? `Sent to ${given}.` : `Sent to ${given}. It isn't connected, so the message waits for it.`;
      }
      const named = r.sent.mentions.map((m) => `@${printable(shownActor(m, r.members))}`);
      return `Sent to #${r.sent.channel}${named.length ? `, mentioning ${named.join(', ')}` : ''}.`;
    });
  } finally { await client.close(); }
}

const target = (word: string, command: string): Target => {
  try {
    return targetOf(word, (w) => `konnect ${command} @${w} for a member, or konnect ${command} '#${w}' for a channel`);
  } catch (e) { throw new UsageError(String((e as Error)?.message ?? e)); }
};

/** Whether anything waits that `receive` would give: one cheap look. */
async function waits(client: TeamClient, from: Target | undefined): Promise<boolean> {
  // A channel's own unread isn't counted unless it is followed, so that one is simply read.
  if (from?.kind === 'channel') return true;
  const u = await client.unread();
  if (from?.kind === 'direct') return u.direct > 0;
  return u.direct > 0 || u.channels.some((c) => c.following && c.unread > 0);
}

export async function receive(ctx: Ctx, rest: string[]) {
  if (rest.length > 1) throw new UsageError(`konnect receive [<from>]: unknown ${printable(rest.slice(1).join(' '))}`);
  const from = rest[0] !== undefined ? target(rest[0], 'receive') : undefined;
  const limit = ctx.args.limit ?? AT_ONCE;
  const team = ctx.team();
  const client = await ctx.open(team);
  try {
    // The names to show are looked up before anything is received, so a failure there loses
    // nothing; without them, messages show stored names. JSON gives stored names, so needs none.
    const members = ctx.json ? [] : await client.members().catch(() => [] as Member[]);
    const show = (ms: { from: string; message: string; sent_at: string }[]) => ms.map((m) => formatMessage(m, members)).join('\n\n');
    const blocks: Block[] = [];
    let printed = 0;
    // Each block is printed as soon as it is received: receiving moves your place, so a failure
    // later never loses what is already yours. JSON is printed once, with why it stopped if it did.
    const onBlock = (b: Block) => {
      blocks.push(b);
      if (ctx.json || !b.messages.length) return;
      const heading = from === undefined && b.kind === 'channel' ? [`#${b.channel}`] : [];
      ctx.out(`${printed++ ? '\n' : ''}${[...heading, show(b.messages)].join('\n')}`);
    };
    const got = () => blocks.reduce((n, b) => n + b.messages.length, 0);
    const more = () => blocks.reduce((n, b) => n + (b.more ?? 0), 0);
    const jsonOf = () => (from === undefined
      ? {
        direct: blocks.find((b) => b.kind === 'direct')?.messages ?? [],
        channels: blocks.filter((b): b is Extract<Block, { kind: 'channel' }> => b.kind === 'channel' && b.messages.length > 0).map((b) => ({ channel: b.channel, messages: b.messages })),
        more: more(),
      }
      : blocks[0]?.messages ?? []);
    let left: Parameters<typeof unreadLine>[0] | undefined;
    const once = async () => {
      if (from === undefined) { left = leftAfter((await readAll(client, onBlock, { limit })).listed); return; }
      const b = await readOne(client, from, limit);
      onBlock(b);
      if (b.error) throw b.error;
    };
    try {
      await once();
      if (!got() && ctx.args.wait !== undefined) {
        let waited = 0;
        while (!got() && waited < ctx.args.wait) {
          const step = Math.min(LOOK_EVERY_MS, ctx.args.wait - waited);
          await ctx.pause(step);
          waited += step;
          if (await waits(client, from).catch(() => false)) { blocks.length = 0; await once(); }
        }
        if (!got()) throw new WaitRanOut(`nothing arrived${from ? ` ${from.kind === 'channel' ? `in #${from.channel}` : `from ${printable(from.given)}`}` : ''} in the time given`);
      }
    } catch (e) {
      if (e instanceof WaitRanOut || !got()) throw e;
      if (ctx.json) ctx.out(JSON.stringify({ received: jsonOf(), stopped: String((e as Error)?.message ?? e) }, null, 2));
      throw new Error(`receiving stopped early: ${(e as Error)?.message ?? e}. What is shown above was received`);
    }
    if (ctx.json) { ctx.out(JSON.stringify(jsonOf(), null, 2)); return; }
    if (!printed) ctx.out(from === undefined ? 'No unread messages.' : `No unread messages ${from.kind === 'channel' ? `in #${from.channel}` : `from ${printable(from.given)}`}.`);
    if (more()) ctx.out(`(${more()} more unread: run konnect receive${rest[0] !== undefined ? ` ${from!.kind === 'channel' ? `'#${from!.channel}'` : printable(rest[0])}` : ''} again)`);
    const elsewhere = left ? unreadLine(left) : '';
    if (elsewhere) ctx.out(`(${elsewhere})`);
  } finally { await client.close(); }
}

export async function history(ctx: Ctx, rest: string[]) {
  if (rest.length !== 1) throw new UsageError('konnect history <of>: name one channel (\'#channel\') or member (@member)');
  const of = target(rest[0], 'history');
  const limit = ctx.args.limit ?? AT_ONCE;
  const team = ctx.team();
  const client = await ctx.open(team);
  try {
    const members = ctx.json ? [] : await client.members().catch(() => [] as Member[]);
    const show = (ms: { from: string; message: string; sent_at: string }[]) => ms.map((m) => formatMessage(m, members)).join('\n\n');
    if (of.kind === 'channel') {
      const ms = (await client.channelHistory(of.channel, limit)).reverse();
      ctx.print(ms, () => (ms.length ? `#${of.channel}\n${show(ms)}` : `No messages in #${of.channel} yet.`));
      return;
    }
    let ms;
    try { ms = (await client.directHistory(of.to, limit)).reverse(); } catch (e) {
      if (e instanceof NotYet) throw e;
      if (e instanceof Refused && /is not a member of kolab/.test(e.message)) throw new Refused(`${printable(of.given)} isn't in team ${team}: konnect team list shows who is`);
      throw e;
    }
    // No messages may mean nobody by that name: said, so a mistyped name isn't taken for silence.
    if (!ms.length && !(members.length ? members : await client.members().catch(() => [] as Member[])).some((m) => m.actor === of.to)) {
      throw new Refused(`${printable(of.given)} isn't in team ${team}: konnect team list shows who is`);
    }
    ctx.print(ms, () => (ms.length ? show(ms) : `No messages between you and ${printable(of.given)} yet.`));
  } finally { await client.close(); }
}
