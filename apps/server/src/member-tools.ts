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
}
