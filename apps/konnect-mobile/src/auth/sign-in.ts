/**
 * Signing a person in to a team from the phone: OAuth 2.1 with PKCE through the system's auth
 * session (expo-auth-session, ASWebAuthenticationSession on iOS), as Kolab's server takes it from
 * konnect's own app (S1 in docs/plans/konnect-mobile.md):
 *
 * - Kolab's discovery document, `/.well-known/oauth-authorization-server` (expo-auth-session reads
 *   OpenID's only, so it is fetched here).
 * - A client registered for this sign-in (dynamic registration, which expo-auth-session doesn't
 *   do), with exactly one redirect: the variant's own, `<bundle ID>:/oauth`. Kolab gives a person's
 *   scopes (choose:kolab, team:<name> intent:create) only to a client whose redirects are all the app's.
 * - The person's choice on Kolab's page: `konjir choose:kolab` lists their teams and the
 *   invitations waiting for them; `konjir team:<name> intent:create` makes a team.
 * - The code exchanged with its PKCE verifier, and konjir_whoami asked which team and who.
 */
import { AuthRequest, CodeChallengeMethod, exchangeCodeAsync, makeRedirectUri, ResponseType, type DiscoveryDocument } from 'expo-auth-session';
import { teamClient } from './mcp';
import type { Login } from './store';
import type { Endpoints } from './tokens';

export interface KolabOAuth extends Endpoints { discovery: DiscoveryDocument; registrationEndpoint: string }

/** Kolab's OAuth endpoints, from its discovery document. */
export async function discover(url: string): Promise<KolabOAuth> {
  const res = await fetch(`${new URL(url).origin}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`Kolab at ${new URL(url).origin} has no OAuth discovery document (${res.status})`);
  const m = await res.json() as Record<string, string | undefined>;
  if (!m.authorization_endpoint || !m.token_endpoint || !m.registration_endpoint) throw new Error('Kolab\'s discovery document lacks an endpoint konnect needs');
  return {
    discovery: { authorizationEndpoint: m.authorization_endpoint, tokenEndpoint: m.token_endpoint, revocationEndpoint: m.revocation_endpoint, registrationEndpoint: m.registration_endpoint },
    tokenEndpoint: m.token_endpoint, revocationEndpoint: m.revocation_endpoint, registrationEndpoint: m.registration_endpoint,
  };
}

/** The one redirect this variant registers and is sent back to: `<scheme>:/oauth`. */
export const redirectFor = (scheme: string) => makeRedirectUri({ native: `${scheme}:/oauth` });

/** What the person asks Kolab's page for. */
export type SignInAsk = { kind: 'choose' } | { kind: 'create'; team: string };

const TEAM_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const scopeFor = (ask: SignInAsk) => {
  if (ask.kind === 'choose') return ['konjir', 'choose:kolab'];
  if (!TEAM_NAME.test(ask.team)) throw new Error('A team\'s name is up to 40 lowercase letters, digits and \'-\', starting with a letter or digit');
  return ['konjir', `team:${ask.team}`, 'intent:create'];
};

/** The person closed the sign-in, or Kolab's page refused it: `message` says which, as Kolab did. */
export class SignInStopped extends Error { name = 'SignInStopped'; }

export async function signIn(opts: { url: string; scheme: string; ask: SignInAsk; clientName: string }): Promise<Login> {
  const kolab = await discover(opts.url);
  const redirectUri = redirectFor(opts.scheme);
  const reg = await fetch(kolab.registrationEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: opts.clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  const client = await reg.json().catch(() => ({})) as { client_id?: string; error_description?: string };
  if (!reg.ok || !client.client_id) throw new Error(`Kolab didn't register the app: ${client.error_description ?? reg.status}`);

  const request = new AuthRequest({
    clientId: client.client_id, redirectUri, responseType: ResponseType.Code,
    usePKCE: true, codeChallengeMethod: CodeChallengeMethod.S256,
    scopes: scopeFor(opts.ask), extraParams: { resource: opts.url },
  });
  // Ephemeral: no cookies shared with Safari, and no system prompt before the page opens.
  const result = await request.promptAsync(kolab.discovery, { preferEphemeralSession: true });
  if (result.type === 'error') throw new SignInStopped(result.params.error_description ?? result.error?.message ?? 'Kolab refused the sign-in');
  if (result.type !== 'success') throw new SignInStopped('The sign-in was closed before it finished');

  const tokens = await exchangeCodeAsync({
    clientId: client.client_id, code: result.params.code!, redirectUri,
    extraParams: { code_verifier: request.codeVerifier!, resource: opts.url },
  }, kolab.discovery);
  if (!tokens.refreshToken) throw new Error('Kolab issued no refresh token');

  // Which team the person picked or made on Kolab's page, and who they are there.
  const mcp = await teamClient(opts.url, { token: async () => tokens.accessToken, renew: async () => tokens.accessToken });
  try {
    const me = (await mcp.callTool({ name: 'konjir_whoami', arguments: {} })).structuredContent as { actor: string; kolab: string; role: string };
    return {
      team: me.kolab, actor: me.actor, role: me.role, url: opts.url, clientId: client.client_id,
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + (tokens.expiresIn ?? 900) * 1000,
    };
  } finally {
    await mcp.close();
  }
}
