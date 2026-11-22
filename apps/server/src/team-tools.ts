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
const invitation = args({ kolab: z.string().describe('The kolab whose invitation it is, as konjir_list_my_teams lists your invitations') });
const makeTeam = args({ name: z.string().describe('The new kolab\'s name, unique across Konjir: up to 40 lowercase letters, digits and \'-\', starting with a letter or digit') });

/**
 * A person's teams from one sign-in (Lee's instruction of 2026-11-21, konnect's app): the person
 * signs in once, with GitHub, and moves between the kolabs they are a member of, takes invitations
 * and makes teams, all in the app. Each is refused to an agent's session; all but the list are
 * refused to any sign-in but the app's.
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

  @McpTool({
    name: 'konjir_accept_invitation',
    description: 'For a person\'s own session in konnect\'s app only: accept the invitation waiting for you to a kolab, as konjir_list_my_teams lists your invitations, exactly as Accept on Kolab\'s sign-in page does: you get the access it gives (Read, enough to send and read messages and to bring your own agents), and your unread there starts now. This sign-in stays where it is: konjir_switch_team moves it there. A kolab with no invitation waiting for you is refused, and so is any other app\'s sign-in, which accepts on the sign-in page. Returns the kolab and the role you would work in there.',
    schema: invitation,
  })
  acceptInvitation({ kolab }: z.infer<typeof invitation>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.acceptTeamInvitation(s, kolab));
  }

  @McpTool({
    name: 'konjir_decline_invitation',
    description: 'For a person\'s own session in konnect\'s app only: decline the invitation waiting for you to a kolab, as konjir_list_my_teams lists your invitations, exactly as Decline on Kolab\'s sign-in page does: no one can accept it any more, and its owner isn\'t told. A kolab with no invitation waiting for you is refused, and so is any other app\'s sign-in.',
    schema: invitation,
  })
  declineInvitation({ kolab }: z.infer<typeof invitation>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.declineTeamInvitation(s, kolab));
  }

  @McpTool({
    name: 'konjir_make_team',
    description: 'For a person\'s own session in konnect\'s app only: make a new kolab, private and yours, with no agent, exactly as a sign-in that creates a team does: its name follows the kolab rules and is unique across Konjir, so a name that is taken, by anyone, yours too, is refused with a free one suggested, and a reserved or badly formed one is refused; you own at most a few kolabs, and make only a few in a while. This sign-in stays where it is: konjir_switch_team moves it there. Any other app\'s sign-in is refused. Returns the kolab and the role you would work in there.',
    schema: makeTeam,
  })
  makeTeam({ name }: z.infer<typeof makeTeam>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.makeTeam(s, name));
  }
}
