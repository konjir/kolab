/**
 * A message for an agent to read (konnect_read, and the event that wakes it), framed so its words
 * can't pass for anything around them: a header and an end line that both carry its id, which its
 * sender couldn't know as they wrote it, and any line of its words that starts as a frame line does
 * marked with `| `. No angle brackets, so a channel event, which escapes them, shows the frame as it is.
 */
import { printable, shownActor, type Member } from './names.js';

const FRAME = /^\s*-----/;

export function framed(m: { id: string; from: string; message: string; sent_at?: string; reply_to?: string | null }, members: Member[]): string {
  const words = printable(m.message).split('\n').map((l) => (FRAME.test(l) ? `| ${l}` : l)).join('\n');
  const at = m.sent_at ? ` at=${printable(m.sent_at)}` : '';
  const reply = m.reply_to ? ` reply_to=${printable(m.reply_to)}` : '';
  return `----- message id=${printable(m.id)} from=@${printable(shownActor(m.from, members))}${at}${reply} -----\n${words}\n----- end id=${printable(m.id)} -----`;
}
