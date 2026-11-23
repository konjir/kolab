/**
 * Forwarding a message: to anyone of the team but its sender (and you), or to a channel, as a new
 * message of yours that quotes it, with a note of your own above it if you write one. Only the
 * note's @mentions notify anyone: the quoted words never wake or ping who they name.
 */
import type { Member } from '@konjir/types';

/** Who a message can be forwarded to: every member but you and the sender. */
export const forwardPeople = <M extends Pick<Member, 'actor'>>(members: readonly M[], me: string, sender: string): M[] =>
  members.filter((m) => m.actor !== me && m.actor !== sender);

/** The forwarded message: your note, then the original quoted line by line under who said it and where. */
export function forwardText(note: string, original: { from: string; where: string; message: string }): string {
  const quoted = original.message.split('\n').map((l) => `> ${l}`).join('\n');
  const head = `> Forwarded from ${original.from}, ${original.where}:`;
  const n = note.trim();
  return `${n ? `${n}\n\n` : ''}${head}\n${quoted}`;
}
