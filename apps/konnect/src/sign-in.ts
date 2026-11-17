/**
 * How a person signs in to a team, with GitHub in the browser, through @konjir/login's own
 * person sign-ins (signInToTeam, signInChoosing):
 *
 *   konnect team <name>   makes the team when the name is free, signs in when they are a member,
 *                         and is refused, with a free name suggested, when it is someone else's
 *   konnect join          (and bare konnect with no team yet) names no team: Kolab's page lists the
 *                         invitations waiting for the GitHub account and the teams it is in, and the
 *                         person picks one there
 *
 * Each sign-in is kept in the team's own file (teams.ts). One that comes back as anyone but the
 * person, or anywhere but what was asked, is revoked and never kept (@konjir/login checks), and a
 * sign-in this attempt saved is revoked and forgotten whatever else fails after it.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SignInRefused, StoredLogin, keepSignIn, logout, signInChoosing, signInToTeam as loginToTeam } from '@konjir/login';
import { CLIENT_NAME, TeamClient, said } from './client.js';
import { printable } from './names.js';
import { teamFileReady, teamsAt } from './teams.js';

/** How a sign-in reaches the person: their browser, and where the steps are said. */
export interface SignInIO { open?: (u: URL) => void | Promise<void>; log: (l: string) => void; env: Record<string, string | undefined> }

/** Kolab's own words, made konnect's: a hint written for konjir (run konjir login) becomes konnect's. */
const konnectWords = (text: string, again: string) => text.replace(/run konjir login( again)?/g, again).replace(/\bkonjir login\b/g, again);

/**
 * `konnect team <name>`: signs in to the team, making it when the name is free. A sign-in kept
 * already that still works is used as it is (`fresh` false).
 */
export async function signInToTeam(team: string, url: string, io: SignInIO): Promise<{ me: { actor: string; kolab: string }; fresh: boolean; made?: boolean }> {
  const file = teamFileReady(team, io.env);
  if (teamsAt(url, io.env).includes(team)) {
    try {
      // open() checks the sign-in is the person's own, in this team.
      const client = await TeamClient.open(team, url, file);
      try { return { me: client.me, fresh: false }; } finally { await client.close(); }
    } catch { /* signed in afresh below */ }
  }
  const kept = () => new StoredLogin(url, { path: file }).saved().tokens?.refresh_token;
  const before = kept();
  try {
    const me = await loginToTeam(url, team, {
      path: file, clientName: CLIENT_NAME, open: io.open, log: io.log,
      opening: `Opening your browser to sign in to team ${team} with GitHub. Kolab's page makes the team if the name is free, or signs you in if you're in it; check what it says, then Allow.`,
      again: `run konnect team ${team} again`,
    });
    return { me, fresh: true };
  } catch (e) {
    // A sign-in this attempt saved is revoked and forgotten: never kept unchecked.
    const saved = kept();
    if (saved && saved !== before) await logout(url, { path: file, forget: true }).catch(() => undefined);
    if (e instanceof SignInRefused) {
      if (e.denied) throw new Error(`you cancelled the sign-in to team ${team}: nothing was kept`);
      throw new Error(`Kolab didn't sign you in to team ${team}: ${konnectWords(e.message, `run konnect team ${team} again`)}${e.suggest ? `. Make your own instead: konnect team ${e.suggest}` : ''}`);
    }
    throw said(new Error(konnectWords(String((e as Error)?.message ?? e), `run konnect team ${team} again`)), team, url);
  }
}

/**
 * `konnect join`, and bare `konnect` with no team yet: signs in naming no team, and keeps the
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
        again: 'run konnect join again',
      });
    } catch (e) {
      if (e instanceof SignInRefused) {
        if (e.nothingToChoose) {
          throw new Error('there is nothing to join yet: no invitation waits for your GitHub account, and you are in no team. Make your own with konnect team <name>, or ask a team\'s owner to run konnect recruit <your GitHub username>, then run konnect join again');
        }
        if (e.denied) throw new Error('you cancelled the sign-in: nothing was kept');
        throw new Error(`Kolab didn't sign you in: ${konnectWords(e.message, 'run konnect join again')}`);
      }
      throw said(new Error(konnectWords(String((e as Error)?.message ?? e), 'run konnect join again')), 'you joined', url);
    }
    const saved = JSON.parse(readFileSync(tmp, 'utf8'))[url];
    if (!saved?.client || !saved?.tokens) throw new Error('Kolab signed you in, but konnect couldn\'t keep the sign-in: run konnect join again');
    await keepSignIn(url, teamFileReady(me.kolab, io.env), { client: saved.client, tokens: saved.tokens, ...(saved.discovery ? { discovery: saved.discovery } : {}) });
    moved = true;
    return { team: me.kolab, actor: me.actor };
  } finally {
    // One not moved under its team (something failed after Kolab signed in) is revoked, never left.
    if (!moved) await logout(url, { path: tmp, forget: true }).catch(() => undefined);
    try { unlinkSync(tmp); } catch { /* none kept */ }
  }
}

/** A person's sign-in that ended or is someone else's, said for the command that found it. */
export const signInLine = (team: string) => `run konnect team ${printable(team)} to sign in again`;
