import { Inject, Injectable } from '@nestjs/common';
import { McpTool, type McpToolContext } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { Kolab } from '@konjir/engine';
import { UNREAD_COUNT_CEILING } from '@konjir/types';
import { args } from './args.js';
import { asAgent } from './results.js';
import { KOLAB } from './tokens.js';

const listMyTeams = args({});
const switchTeam = args({ kolab: z.string().describe('The kolab to work in now: one of yours, as konjir_list_my_teams lists them') });

/**
 * A person's teams from one sign-in (Lee's instruction of 2026-11-21, konnect's app): the person
 * signs in once, with GitHub, and moves between the kolabs they are a member of. Each is refused to
 * an agent's session.
 */
@Injectable()
export class TeamTools {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @McpTool({
    name: 'konjir_list_my_teams',
    description: `For a person's own session only: every kolab you are a member of (teams), by name, each with the role your session works in (a role is your session's, not a kolab's, and konjir_switch_team keeps it, so it is the same on every row), whether you own it (owner), whether this session works there now (current), and your own inbox there, as your answers there count it: unread, your unread direct messages and the unread in the channels you follow, and mentions, the unread that mention you in any channel, each counted up to ${UNREAD_COUNT_CEILING.toLocaleString('en')} with unread_more and mentions_more saying there are more. And the invitations waiting for you (invitations: the kolab, who invited you and when), which you accept or decline on Kolab's sign-in page. konjir_switch_team moves this sign-in to another of your kolabs.`,
    schema: listMyTeams,
    annotations: { readOnlyHint: true },
  })
  listMyTeams(_: z.infer<typeof listMyTeams>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.myTeams(s));
  }

  @McpTool({
    name: 'konjir_switch_team',
    description: 'For a person\'s own session in konnect\'s app only: move this sign-in to another kolab you are a member of, as konjir_list_my_teams lists them, in the same role. This session ends, its streams close, and this access token works no more; your refresh token now signs you in there: get the next access token from the token endpoint (grant_type=refresh_token) with the refresh token you hold, then read konjir_whoami and subscribe again. All of it happens, or none of it does. A kolab you aren\'t a member of is refused, and so is any other app\'s sign-in, which signs in to each kolab by itself. Returns the kolab and the role you work in there.',
    schema: switchTeam,
  })
  switchTeam({ kolab }: z.infer<typeof switchTeam>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.switchTeam(s, kolab));
  }
}
