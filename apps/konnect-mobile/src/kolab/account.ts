/**
 * Deleting the person's own account (konjir_delete_my_account; Lee's decision of 2026-11-23, "remove
 * me, keep my words"), as App Store guideline 5.1.1(v) asks of an app anyone can sign up in. Kolab
 * refuses while the person owns a team someone else is in, and says which, for the app to list.
 */
import type { Client } from '@modelcontextprotocol/client';
import type { AccountDeleted, AccountDeletionBlocker } from '@konjir/types';
import { hasTool, KolabLacks, KolabRefused } from './api';

export type { AccountDeleted, AccountDeletionBlocker };

/** Kolab refused to delete the account until each of `blockers` is dealt with. */
export class AccountBlocked extends KolabRefused {
  name = 'AccountBlocked';
  constructor(message: string, readonly blockers: AccountDeletionBlocker[]) { super(message); }
}

/** What the app tells the person deleting their account does, in Lee's words. */
export const DELETION_EXPLAINED = [
  'You leave every team you are in.',
  'You are signed out everywhere, on every phone and computer, and this phone stops getting notifications.',
  'Your own agents are removed, with their sign-ins.',
  'Your profile is deleted: your GitHub username and picture are no longer linked to Kolab.',
  'Messages you sent stay in their conversations, shown as from "a deleted account".',
  'Teams you alone own must be handed over or deleted first. A team only you are in is deleted with your account.',
  'This can\'t be undone. Signing in again later with the same GitHub account starts a new, empty account.',
] as const;

/** Deletes the account the client is signed in as, named `account` as the person typed it. */
export async function deleteAccount(client: Client, account: string): Promise<AccountDeleted> {
  if (!(await hasTool(client, 'konjir_delete_my_account'))) throw new KolabLacks('This Kolab can\'t delete accounts yet. Try again after it is updated.');
  const r = await client.callTool({ name: 'konjir_delete_my_account', arguments: { account } });
  if (r.isError) {
    const text = (r.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join(' ').trim() || 'Kolab refused to delete the account';
    const blocked = (r.structuredContent as { blocked?: AccountDeletionBlocker[] } | undefined)?.blocked;
    if (blocked?.length) throw new AccountBlocked(text, blocked);
    throw new KolabRefused(text);
  }
  return r.structuredContent as unknown as AccountDeleted;
}
