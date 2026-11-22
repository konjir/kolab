/**
 * The person's teams, across their GitHub account: which they belong to (konjir_list_my_teams) and
 * moving the sign-in to one (konjir_switch_team). Through an adapter, so tests stand in for Kolab,
 * and a Kolab without these tools still shows the one team the sign-in is in.
 */
import type { Client } from '@modelcontextprotocol/client';
import { call, callNew, hasTool } from './api';

export interface MyTeam {
  kolab: string; role: string; owner: string; current: boolean;
  unread: number; unread_more: boolean; mentions: number; mentions_more: boolean;
  /** What the team adds to the app's badge, when Kolab says (else its unread). */
  badge?: number;
}
export interface Invitation { kolab: string; invited_by: string; invited_at: string }
export interface MyTeams { teams: MyTeam[]; invitations: Invitation[]; switching: boolean }

export interface TeamsAdapter {
  list(client: Client, current: { team: string; role: string }): Promise<MyTeams>;
  /** Moves the sign-in to `kolab`, with a client holding the access token in use (which Kolab ends). */
  switchTo(client: Client, kolab: string): Promise<{ kolab: string; role: string }>;
  /** Accepts the invitation to `kolab` (konjir_accept_invitation); it doesn't move the sign-in there. */
  accept(client: Client, kolab: string): Promise<{ kolab: string; role: string }>;
  decline(client: Client, kolab: string): Promise<void>;
  /** Makes the team `name`, the person's own (konjir_make_team); it doesn't move the sign-in there. */
  make(client: Client, name: string): Promise<{ kolab: string; role: string }>;
}

export const kolabTeams: TeamsAdapter = {
  async list(client, current) {
    if (!(await hasTool(client, 'konjir_list_my_teams'))) {
      // A Kolab before konjir_list_my_teams: the team the sign-in is in, and nothing to switch to.
      return { teams: [{ kolab: current.team, role: current.role, owner: '', current: true, unread: 0, unread_more: false, mentions: 0, mentions_more: false }], invitations: [], switching: false };
    }
    const r = await call<{ teams: MyTeam[]; invitations?: Invitation[] }>(client, 'konjir_list_my_teams');
    return { teams: r.teams, invitations: r.invitations ?? [], switching: await hasTool(client, 'konjir_switch_team') };
  },
  async switchTo(client, kolab) {
    if (!(await hasTool(client, 'konjir_switch_team'))) throw new Error('This Kolab can\'t switch teams yet: sign out, and sign in to the other team.');
    return call<{ kolab: string; role: string }>(client, 'konjir_switch_team', { kolab });
  },
  accept: (client, kolab) => callNew<{ kolab: string; role: string }>(client, 'konjir_accept_invitation', { kolab }),
  async decline(client, kolab) { await callNew(client, 'konjir_decline_invitation', { kolab }); },
  make: (client, name) => callNew<{ kolab: string; role: string }>(client, 'konjir_make_team', { name }),
};

/** Teams in the switcher's order: the current one first, then those with mentions, then unread, then by name. */
export function switcherOrder(teams: readonly MyTeam[]): MyTeam[] {
  return [...teams].sort((a, b) => Number(b.current) - Number(a.current) || b.mentions - a.mentions || b.unread - a.unread || a.kolab.localeCompare(b.kolab));
}

/** The app's badge: every team's, as Kolab counts it for a push (`badge`), or else its unread. */
export const badgeOf = (teams: readonly MyTeam[]) => teams.reduce((n, t) => n + (t.badge ?? t.unread), 0);
