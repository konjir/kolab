/**
 * Where the app goes for a member, a conversation and a time, the same from every screen: an agent,
 * anyone's, opens the agent screen (its owner sees what it does there too); a person, their profile.
 */
import type { Href } from 'expo-router';

export const memberHref = (actor: string, kind: string | undefined): Href =>
  kind === 'agent' ? { pathname: '/agent/[actor]', params: { actor } } : { pathname: '/profile/[actor]', params: { actor } };

export const conversationHref = (kind: 'channel' | 'dm', name: string, extra?: { as?: string; only?: string }): Href =>
  ({ pathname: '/c/[kind]/[name]', params: { kind, name, ...extra } });

/** A list's time: the time of day today, else the day and month. */
export function shortWhen(iso: string | undefined, now = new Date()): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
