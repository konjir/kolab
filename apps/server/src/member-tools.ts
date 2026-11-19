import { Inject, Injectable } from '@nestjs/common';
import { McpTool, type McpToolContext } from '@onivoro/server-mcp';
import * as z from 'zod/v4';
import { AccessError, Kolab, LimitError } from '@konjir/engine';
import { args } from './args.js';
import { Limit } from './oauth/oauth.controller.js';
import { PAGED, paging } from './paging.js';
import { asAgent } from './results.js';
import { KOLAB, OAUTH_OPTIONS, type OAuthOptions } from './tokens.js';

const invite = args({
  accounts: z.array(z.string()).min(1).max(10).describe('The GitHub usernames to invite, 1 to 10, as they are on GitHub (an @ before one is allowed): each a person\'s account, never an organization\'s'),
});
const listInvitations = args({ ...paging });
const withdrawInvitation = args({ invitation: z.string().describe('The invitation\'s id, ivt_…, as konjir_invite or konjir_list_invitations gives it') });
const removeMember = args({ member: z.string().describe('The person to remove, by name, as konjir_list_members names them') });
const leaveKolab = args({});
const ownKolab = args({ kolab: z.string().describe('Your kolab\'s name, the one this session is in: named, so nobody does this to the wrong one') });
const removeAgent = args({ agent: z.string().describe('Your agent to remove: its label (as konjir_list_agents and konjir_list_members give it), its whole name, or <you>/<label>') });

/**
 * Who belongs to a kolab, by the person's own session (Lee's instruction of 2026-11-16, konnect):
 * its owner invites people by their GitHub accounts, lists and withdraws those invitations, and
 * removes a member; a member leaves. An invitation is accepted or declined on Kolab's sign-in page
 * (a `choose:kolab` sign-in), never here. Each is refused to an agent's session.
 */
@Injectable()
export class MemberTools {
  /**
   * konjir_invite's lookups at GitHub, which share the OAuth app's one rate limit (5,000 an hour):
   * each person at most 100 an hour, and all of them at most 2,000 an hour, per process, so no one
   * person can use up what everyone else's invitations need. Counted per lookup, once Kolab has
   * found the caller owns the kolab, and before GitHub is asked.
   */
  private readonly lookups = new Limit(100, 2000, 60 * 60_000);

  constructor(
    @Inject(KOLAB) private readonly kolab: Kolab,
    @Inject(OAUTH_OPTIONS) private readonly oauth: OAuthOptions,
  ) {}

  @McpTool({
    name: 'konjir_invite',
    description: 'For the owner of your kolab, a person, only: invite people to it by their GitHub usernames. Each name is looked up on GitHub first, and the invitation keeps the account\'s permanent id, so only that account can accept it, even if the name later changes hands. A name with no GitHub account, or one that isn\'t a person\'s (an organization\'s or a bot\'s), refuses the whole call, by name, and nothing is invited. You look up at most 100 names an hour. The person accepts or declines on Kolab\'s sign-in page, the next time they sign in without naming a kolab (npx @konjir/konnect); accepted, it gives them Read, which is enough to send and read messages and to bring their own agents. It waits until then, or until you withdraw it (konjir_withdraw_invitation). already_members names accounts that are members already; already_invited, invitations that were open already; declined_recently, accounts that declined an invitation to your kolab in the last 30 days, which aren\'t asked again until then.',
    schema: invite,
  })
  invite({ accounts }: z.infer<typeof invite>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const idp = this.oauth.identity;
      if (!idp?.lookup) throw new AccessError('inviting people by their GitHub accounts needs GitHub sign-in set up on this Kolab');
      // Keyed by the person, never their session: a person holds a session on each machine.
      const { actor } = await this.kolab.sessionInfo(s);
      const find = async (login: string) => {
        if (!this.lookups.take(`actor:${actor}`)) throw new LimitError('too many GitHub accounts looked up just now; wait a while before inviting more');
        return idp.lookup!(login);
      };
      return this.kolab.inviteAccounts(s, accounts, { provider: idp.id, find });
    });
  }

  @McpTool({
    name: 'konjir_list_invitations',
    description: `For the owner of your kolab only: the invitations of your kolab that wait for an answer, newest first, each with its id, the GitHub account it names (as you typed it), what it gives, who made it and when.${PAGED}`,
    schema: listInvitations,
    annotations: { readOnlyHint: true },
  })
  listInvitations({ cursor, limit }: z.infer<typeof listInvitations>, context?: McpToolContext) {
    return asAgent(context, async (s) => {
      const { kolab, items, next } = await this.kolab.invitationsPage(s, { cursor, limit });
      return { kolab, invitations: items, next };
    });
  }

  @McpTool({
    name: 'konjir_withdraw_invitation',
    description: 'For the owner of your kolab only: withdraw an invitation that waits for an answer, by its id, so no one can accept it.',
    schema: withdrawInvitation,
  })
  withdrawInvitation({ invitation }: z.infer<typeof withdrawInvitation>, context?: McpToolContext) {
    return asAgent(context, async (s) => ({ withdrawn: await this.kolab.withdrawInvitation(s, invitation) }));
  }

  @McpTool({
    name: 'konjir_remove_member',
    description: 'For the owner of your kolab only: remove a member, a person, from it. Their grant there goes, and their agents\' grants there with it; their sessions there, and their agents\', end. Access they hold some other way (a team, an organization\'s base permission) stays. Not yourself, and not an agent: an agent goes with its owner. agents names the agents whose grants went; ended, how many sessions ended.',
    schema: removeMember,
  })
  removeMember({ member }: z.infer<typeof removeMember>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.removeKolabMember(s, member));
  }

  @McpTool({
    name: 'konjir_leave_kolab',
    description: 'For a person\'s own session only: leave your kolab. Your grant there goes, and your agents\' grants there with it; your sessions there, this one too, and your agents\', end. Its owner can\'t leave it. To come back, ask its owner to invite you again.',
    schema: leaveKolab,
  })
  leaveKolab(_: z.infer<typeof leaveKolab>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.leaveKolab(s));
  }

  @McpTool({
    name: 'konjir_archive_kolab',
    description: 'For the owner of your kolab only, from a person\'s own session: archive it, named. As an admin\'s archive does, it disappears from listings and can\'t be used: every session there ends, this one too. Nothing is deleted, its name stays reserved, and a Konjir admin can unarchive it. ended, how many sessions ended.',
    schema: ownKolab,
  })
  archiveKolab({ kolab }: z.infer<typeof ownKolab>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.archiveOwnKolab(s, kolab));
  }

  @McpTool({
    name: 'konjir_erase_kolab',
    description: 'For the owner of your kolab only, from a person\'s own session: erase it, named, for good, when it holds no documents (a kolab of messages, such as a konnect team). Its messages and channels, members, invitations, leases and hosts go, every session there ends, this one too, every sign-in to it is revoked, and its name is free again. A kolab with documents is refused: archive it instead. It can\'t be undone. ended, how many sessions ended; revoked, how many sign-ins were revoked; messages, how many messages went.',
    schema: ownKolab,
    annotations: { destructiveHint: true },
  })
  eraseKolab({ kolab }: z.infer<typeof ownKolab>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.eraseOwnKolab(s, kolab));
  }

  @McpTool({
    name: 'konjir_remove_agent',
    description: 'For a person\'s own session only: remove one of your own agents from your kolab, as it goes when you leave. Its grant there goes, its sign-ins to the kolab are revoked, and its sessions there end; it keeps its grants elsewhere, and setting the same label up again later gives it access afresh. Never someone else\'s agent: their owner removes it, or the kolab\'s owner removes them. removed is the agent\'s whole name; revoked, how many of its sign-ins were revoked; ended, how many sessions ended.',
    schema: removeAgent,
  })
  removeAgent({ agent }: z.infer<typeof removeAgent>, context?: McpToolContext) {
    return asAgent(context, (s) => this.kolab.removeOwnAgent(s, agent));
  }
}
