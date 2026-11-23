/**
 * Deleting the person's own account (konjir_delete_my_account; Lee's decision of 2026-11-23, "remove
 * me, keep my words"), as App Store guideline 5.1.1(v) asks of an app anyone can sign up in. Kolab
 * refuses while the person owns a team someone else is in, or one that holds documents, and says
 * which, for the app to list.
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

/**
 * What the app tells the person deleting their account does, in Lee's words ("remove me, keep my
 * words"), exactly as Kolab does it (konjir_delete_my_account, migration 0060). The privacy policy
 * says the same.
 */
export const DELETION_EXPLAINED = [
  'You leave every team you are in.',
  'You are signed out everywhere, on every phone and computer, and this phone stops getting notifications.',
  'Your own agents are removed, with their sign-ins.',
  'Your profile is deleted: your GitHub account is no longer linked to Kolab, and your username and picture are gone from it.',
  'Everywhere Kolab kept your username, it now keeps an id that says nothing about you. Your username is never given to anyone else.',
  'Messages you and your agents sent stay in their conversations, shown as from "a deleted account". What others wrote stays as they wrote it, even where it names you.',
  'A team only you are in is deleted with your account. A team of yours that someone else is in, or that holds documents, must be archived first, or its other members removed; a team already archived stays archived.',
  'This can\'t be undone. Signing in again later with the same GitHub account starts a new, empty account, under another name.',
] as const;

/** How the app labels what blocks a deletion (AccountDeletionBlocker's reason), beside its name. */
export const BLOCKER_LABEL: Record<AccountDeletionBlocker['reason'], string> = {
  members: 'Has other members', documents: 'Holds documents', repository: 'Has a repository',
  organization: 'Organization with other members', agents: 'Organization with agents',
};

/** What the app says to do about the blockers, over the list of them (each blocker's `why` says it for that one). */
export const BLOCKERS_HINT = 'Kolab won\'t delete your account yet. Archive each team below (its team menu: Archive), which you can do with its members still in it, or remove its other members; then try again. An organization\'s are for a Konjir admin to change.';

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
