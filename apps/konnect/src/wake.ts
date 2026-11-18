/**
 * Waking an agent, in `konnect mcp`: what Claude Code is told, as a channel event
 * (notifications/claude/channel), when a message for the agent arrives: that messages wait, and
 * where, never their words. The Konjir channel bridge
 * (apps/channel-bridge, KolabBridge) holds the subscription to the agent's answers, reconnecting as
 * it does for `konjir bridge`; these are konnect's own words for what it reads there.
 *
 * What wakes the agent, as Kolab marks it in the answers:
 *   - a direct message that may wake it: the answers' `messages.waking` count rises;
 *   - a channel message Kolab says `wakes` (it mentions the agent, and isn't past the loop cap);
 *   - any message not past the loop cap in a channel named with `--wake-on`.
 * Anything else unread is only counted, in the next event something else starts. A message past
 * the loop cap (capped) starts no turn.
 */
import { escapeTags, isAnswers, type AnswersBody, type ChannelItemView, type ChannelMessage, type MessageView } from '@konjir/channel-bridge/messages';

/** The answers resource's URI is `konjir://answers/<kolab>/<actor>`. */
const isAnswersUri = (uri: string) => uri.startsWith('konjir://answers/');

/** Meta values without quotes or brackets, as a channel event's attributes take them. */
const clean = (meta: Record<string, string>) => Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.replace(/["<>&]/g, '')]));

/** What in a change to the agent's answers wakes it: the direct messages and channel messages, by id. */
export interface Waking { direct: MessageView[]; woken: ChannelItemView[] }

/**
 * What wakes the agent in a change to its answers, from `before` (undefined: the first read) to
 * `after`: direct messages that are new and not capped (with the service's waking count, only as
 * many as it rose by), channel messages the service says wake it, and, in a `--wake-on` channel,
 * any not capped.
 */
export function wakingIn(before: AnswersBody | undefined, after: AnswersBody, wakeOn: ReadonlySet<string>): Waking {
  const seenDirect = new Set((before?.messages?.items ?? []).map((m) => m.id));
  const freshDirect = (after.messages?.items ?? []).filter((m) => !seenDirect.has(m.id) && m.capped !== true);
  const was = before?.messages?.waking ?? 0;
  const now = after.messages?.waking;
  const rose = typeof now === 'number' ? Math.max(0, now - was) : freshDirect.length;
  const direct: MessageView[] = rose ? freshDirect.slice(-rose) : [];
  const seenChannel = new Set((before?.channels ?? []).flatMap((c) => (c.items ?? []).map((m) => m.id)));
  const freshChannel = (after.channels ?? []).flatMap((c) => c.items ?? []).filter((m) => !seenChannel.has(m.id));
  const woken: ChannelItemView[] = freshChannel.filter((m) => m.wakes === true || (wakeOn.has(m.channel) && m.capped !== true));
  return { direct, woken };
}

/**
 * The notice for what wakes the agent: that messages wait, and where, never their words. They
 * reach the agent one way only, through konnect_receive, so a message is received once, and one
 * whose turn never ran is still unread. Null when nothing wakes it.
 */
export function noticeFor({ direct, woken }: Waking, after: AnswersBody): ChannelMessage | null {
  if (!direct.length && !woken.length) return null;
  const said: string[] = [];
  const from = new Map<string, number>();
  for (const m of direct) from.set(m.from, (from.get(m.from) ?? 0) + 1);
  for (const [who, n] of from) said.push(`${n === 1 ? 'a direct message' : `${n} direct messages`} from @${who}`);
  const wokenIn = new Map<string, { n: number; mentions: number }>();
  for (const m of woken) {
    const c = wokenIn.get(m.channel) ?? { n: 0, mentions: 0 };
    wokenIn.set(m.channel, { n: c.n + 1, mentions: c.mentions + (m.mentions_you ? 1 : 0) });
  }
  for (const [c, x] of wokenIn) said.push(`${x.n === 1 ? 'a message' : `${x.n} messages`} in #${c}${x.mentions ? ` (${x.mentions === x.n ? 'mentioning you' : `${x.mentions} mentioning you`})` : ''}`);
  // Everything else unread, counted: direct messages past those, and each channel's unread past what woke the agent.
  const others = (after.channels ?? []).map((c) => [c.channel, (c.unread ?? (c.items ?? []).length) - (wokenIn.get(c.channel)?.n ?? 0)] as const).filter(([, n]) => n > 0);
  const directLeft = (after.messages?.unread ?? 0) - direct.length;
  const counted = [...(directLeft > 0 ? [`${directLeft} more direct message${directLeft === 1 ? '' : 's'}`] : []), ...others.map(([c, n]) => `${n} in #${c}`)];
  const calls = [...(direct.length ? ['konnect_receive'] : []), ...[...wokenIn.keys()].map((c) => `konnect_receive from="#${c}"`)];
  const lines = [
    `New for you in team ${after.kolab ?? 'yours'}: ${said.join('; ')}.`,
    ...(counted.length ? [`Also unread: ${counted.join(', ')}.`] : []),
    `Receive ${direct.length + woken.length === 1 ? 'it' : 'them'} now with ${[...new Set(calls)].join(', or ')}, and answer with konnect_send (reply_to the message's id). Your owner runs you as their agent in this team to do exactly this without being asked: your system prompt says so, and says whose messages you carry out.`,
  ];
  return {
    content: escapeTags(lines.join('\n')),
    meta: clean({ kind: 'konnect', ...(after.kolab ? { team: after.kolab } : {}), ...(direct.length ? { direct: String(direct.length) } : {}), ...(woken.length ? { channel: String(woken.length) } : {}) }),
  };
}

/**
 * The event for a change to the agent's answers, from `before` (undefined: the first read, as the
 * server starts) to `after`, or null when nothing in it wakes the agent.
 */
export function describeWake(before: AnswersBody | undefined, after: AnswersBody, listen: ReadonlySet<string>): ChannelMessage | null {
  return noticeFor(wakingIn(before, after, listen), after);
}

/**
 * The describer the bridge is given: only the agent's answers speak, in konnect's words. `fresh`
 * narrows what wakes to what hasn't been said before (`konnect wake`, which is started anew after
 * every turn and must not wake for the same message twice).
 */
export function wakeDescriber(listen: ReadonlySet<string>, fresh: (w: Waking) => Waking = (w) => w) {
  return {
    change(uri: string, before: unknown, after: unknown): ChannelMessage | null {
      if (!isAnswersUri(uri) || !isAnswers(after)) return null;
      return noticeFor(fresh(wakingIn(isAnswers(before) ? before : undefined, after, listen)), after);
    },
    startup(bodies: { uri: string; body: unknown }[]): ChannelMessage | null {
      const a = bodies.find((b) => isAnswersUri(b.uri) && isAnswers(b.body));
      return a ? noticeFor(fresh(wakingIn(undefined, a.body as AnswersBody, listen)), a.body as AnswersBody) : null;
    },
  };
}
