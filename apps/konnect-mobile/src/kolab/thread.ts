/**
 * A conversation's rows for an inverted list (newest first, at the bottom of the screen): each
 * message knows whether it starts a group (another sender, or more than a minute after the one
 * before), day separators fall between days, and a "New" line sits above the first unread message.
 */
export interface Msg { id: string; from: string; message: string; reply_to?: string | null; sent_at: string; capped?: boolean; mentions?: string[]; pending?: 'sending' | 'failed' }

export type Row =
  | { type: 'message'; key: string; msg: Msg; head: boolean }
  | { type: 'day'; key: string; label: string }
  | { type: 'new'; key: string };

const dayOf = (iso: string) => iso.slice(0, 10);

/** `newestFirst` messages into rows, newest first, with the New line before `firstUnread` (oldest unread). */
export function rowsOf(newestFirst: readonly Msg[], firstUnread?: string, dayLabel: (iso: string) => string = dayOf): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < newestFirst.length; i++) {
    const msg = newestFirst[i]!;
    const older = newestFirst[i + 1];
    const head = !older || older.from !== msg.from || Date.parse(msg.sent_at) - Date.parse(older.sent_at) > 60_000 || dayOf(older.sent_at) !== dayOf(msg.sent_at);
    rows.push({ type: 'message', key: msg.id, msg, head });
    if (msg.id === firstUnread) rows.push({ type: 'new', key: `new-${msg.id}` });
    if (!older || dayOf(older.sent_at) !== dayOf(msg.sent_at)) rows.push({ type: 'day', key: `day-${dayOf(msg.sent_at)}`, label: dayLabel(msg.sent_at) });
  }
  return rows;
}

/**
 * A message's nonce, which is also its id on screen until Kolab's answer: a ULID's shape (time,
 * then randomness, Crockford base 32), within Kolab's 1 to 100 characters of [A-Za-z0-9._:-], and
 * never the same twice.
 */
export function nonce(now = Date.now()): string {
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = '';
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = B32[t % 32] + time;
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[Math.floor(Math.random() * 32)];
  return time + rand;
}

/** What a reply quotes: the start of the message it answers, on one line. */
export const quoteOf = (text: string, max = 100) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
