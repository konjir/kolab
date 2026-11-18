/**
 * How a person logs in to a team, with GitHub in the browser, through @konjir/login's own person
 * sign-ins (signInToTeam, signInChoosing):
 *
 *   konnect login <team>        the team must be there, and the person in it or invited to it
 *   konnect team create <name>  the name must be free; the person becomes the team's owner
 *   konnect login               names no team: the page lists the invitations waiting for the GitHub
 *                               account and the teams it is in, and the person picks one there
 *
 * Each login is kept in the team's own file (teams.ts). One that comes back as anyone but the
 * person, or anywhere but what was asked, is revoked and never kept (@konjir/login checks), and a
 * login this attempt saved is revoked and forgotten whatever else fails after it.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SignInRefused, StoredLogin, keepSignIn, logout, signInChoosing, signInToTeam as loginToTeam } from '@konjir/login';
import { CLIENT_NAME, Refused, TeamClient, said } from './client.js';
import { teamFileReady, teamsAt } from './teams.js';

/** How a sign-in reaches the person: their browser, and where the steps are said. */
export interface SignInIO { open?: (u: URL) => void | Promise<void>; log: (l: string) => void; env: Record<string, string | undefined> }

/** Kolab's own words, made konnect's: a hint written for konjir (run konjir login) becomes konnect's. */
const konnectWords = (text: string, again: string) => text.replace(/run konjir login( again)?/g, again).replace(/\bkonjir login\b/g, again);

/** Whether a login to a named team must find it (`konnect login <team>`) or must create it (`konnect team create <name>`). */
export type Intent = 'join' | 'create';

/**
 * `konnect login <team>` and `konnect team create <name>`: logs in to the team. With 'join' the team
 * must be there, and the person in it or invited to it; with 'create' the name must be free. A login
 * kept already that still works is used as it is (`fresh` false).
 */
export async function signInToTeam(team: string, url: string, io: SignInIO, intent: Intent): Promise<{ me: { actor: string; kolab: string }; fresh: boolean }> {
  const file = teamFileReady(team, io.env);
  const again = intent === 'create' ? `run konnect team create ${team} again` : `run konnect login ${team} again`;
  if (teamsAt(url, io.env).includes(team)) {
    try {
      // open() checks the login is the person's own, in this team.
      const client = await TeamClient.open(team, url, file);
      try { return { me: client.me, fresh: false }; } finally { await client.close(); }
    } catch { /* logged in afresh below */ }
  }
  const kept = () => new StoredLogin(url, { path: file }).saved().tokens?.refresh_token;
  const before = kept();
  try {
    const me = await loginToTeam(url, team, {
      path: file, clientName: CLIENT_NAME, open: io.open, log: io.log, ...({ intent } as object),
      opening: intent === 'create'
        ? `Opening your browser to create team ${team} with GitHub, with you as its owner. Check what the page says, then Allow.`
        : `Opening your browser to log in to team ${team} with GitHub. Check what the page says, then Allow.`,
      again,
    });
    return { me, fresh: true };
  } catch (e) {
    // A login this attempt saved is revoked and forgotten: never kept unchecked.
    const saved = kept();
    if (saved && saved !== before) await logout(url, { path: file, forget: true }).catch(() => undefined);
    if (e instanceof SignInRefused) {
      if (e.denied) throw new Refused(`you cancelled ${intent === 'create' ? `creating team ${team}` : `the login to team ${team}`}: nothing was kept`);
      throw new Refused(`the service didn't ${intent === 'create' ? `create team ${team}` : `log you in to team ${team}`}: ${konnectWords(e.message, again)}${e.suggest ? `. A name that is free: konnect team create ${e.suggest}` : ''}`);
    }
    throw said(new Error(konnectWords(String((e as Error)?.message ?? e), again)), team, url);
  }
}

/**
 * `konnect login` with no team: signs in naming no team, and keeps the
 * sign-in under the team picked on Kolab's page. The sign-in is first kept in a file of its own in
 * the teams folder, then moved under the team's name (any sign-in that file kept before for this
 * Kolab is revoked: this one replaces it), and the first file removed whatever happens.
 */
export async function joinTeam(url: string, io: SignInIO): Promise<{ team: string; actor: string }> {
  // A file of its own, in the teams folder, made ready as a team's is; never read as a team (its name starts with a dot).
  const tmp = join(dirname(teamFileReady('choosing', io.env)), `.choosing-${randomBytes(6).toString('hex')}.json`);
  let moved = false;
  try {
    let me;
    try {
      me = await signInChoosing(url, {
        path: tmp, clientName: CLIENT_NAME, open: io.open, log: io.log,
        opening: 'Opening your browser to sign in with GitHub. Kolab\'s page lists the invitations waiting for you and the teams you\'re in: pick one there.',
        again: 'run konnect login again',
      });
    } catch (e) {
      if (e instanceof SignInRefused) {
        if (e.nothingToChoose) {
          throw new Refused('there is nothing to log in to yet: no invitation waits for your GitHub account, and you are in no team. Create your own with konnect team create <name>, or ask a team\'s owner to run konnect team invite <your GitHub username>, then run konnect login again');
        }
        if (e.denied) throw new Refused('you cancelled the login: nothing was kept');
        throw new Refused(`the service didn't log you in: ${konnectWords(e.message, 'run konnect login again')}`);
      }
      throw said(new Error(konnectWords(String((e as Error)?.message ?? e), 'run konnect login again')), 'you picked', url);
    }
    const saved = JSON.parse(readFileSync(tmp, 'utf8'))[url];
    if (!saved?.client || !saved?.tokens) throw new Error('the service logged you in, but konnect couldn\'t keep the login: run konnect login again');
    await keepSignIn(url, teamFileReady(me.kolab, io.env), { client: saved.client, tokens: saved.tokens, ...(saved.discovery ? { discovery: saved.discovery } : {}) });
    moved = true;
    return { team: me.kolab, actor: me.actor };
  } finally {
    // One not moved under its team (something failed after Kolab signed in) is revoked, never left.
    if (!moved) await logout(url, { path: tmp, forget: true }).catch(() => undefined);
    try { unlinkSync(tmp); } catch { /* none kept */ }
  }
}
