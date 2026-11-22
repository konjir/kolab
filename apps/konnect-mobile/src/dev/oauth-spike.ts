/**
 * Phase 0's sign-in spike (docs/plans/konnect-mobile.md), as far as Kolab allows today, without
 * S1: expo-auth-session against Kolab's OAuth 2.1 server, with its discovery document from
 * `/.well-known/oauth-authorization-server` (expo-auth-session reads only OpenID's, so it is
 * fetched here and mapped), dynamic client registration (which expo-auth-session doesn't do, so it
 * is a fetch here), and PKCE (S256), which expo-auth-session does. Each step is logged, and where
 * Kolab refuses, what it said.
 *
 * Only against a Kolab on this machine (scripts/local-kolab.mts). Nothing is kept.
 */
import { AuthRequest, CodeChallengeMethod, makeRedirectUri, ResponseType, type DiscoveryDocument } from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

const showParams = (u: string) => {
  const url = new URL(u);
  return [...url.searchParams.keys()].sort().map((k) => (k === 'code_challenge' || k === 'state' ? `${k}=<${url.searchParams.get(k)!.length} chars>` : `${k}=${url.searchParams.get(k)}`)).join(' ');
};

async function register(endpoint: string, redirectUri: string) {
  const res = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'konnect mobile spike', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  const body = await res.json().catch(() => ({})) as { client_id?: string; error?: string; error_description?: string };
  return { status: res.status, ...body };
}

/** Opens the auth session at `request`'s URL, and closes it after `holdMs` if nothing came back. */
async function prompt(request: AuthRequest, discovery: DiscoveryDocument, holdMs: number, log: (l: string) => void) {
  const closing = setTimeout(() => { log(`   (closing the auth session after ${holdMs / 1000} s)`); WebBrowser.dismissAuthSession(); }, holdMs);
  try {
    const result = await request.promptAsync(discovery, { preferEphemeralSession: true });
    log(`   promptAsync came back: ${result.type}${result.type === 'error' || result.type === 'success' ? ` ${JSON.stringify(result.params)}` : ''}`);
  } catch (e) {
    log(`   promptAsync threw: ${(e as Error).message}`);
  } finally {
    clearTimeout(closing);
  }
}

export async function runOAuthSpike(mcpUrl: string, scheme: string, log: (line: string) => void, holdMs = 20_000) {
  const origin = new URL(mcpUrl).origin;
  const meta = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
  log(`ok discovery: issuer ${String(meta.issuer)}; PKCE methods ${JSON.stringify(meta.code_challenge_methods_supported)}; registration ${meta.registration_endpoint ? 'offered' : 'not offered'}`);
  const discovery: DiscoveryDocument = {
    authorizationEndpoint: meta.authorization_endpoint as string,
    tokenEndpoint: meta.token_endpoint as string,
    revocationEndpoint: meta.revocation_endpoint as string | undefined,
    registrationEndpoint: meta.registration_endpoint as string | undefined,
  };

  // The redirect the app would use (RFC 8252 §7.1): the variant's own scheme, `<scheme>:/oauth`.
  const native = makeRedirectUri({ native: `${scheme}:/oauth` });
  const refused = await register(discovery.registrationEndpoint!, native);
  log(`${refused.client_id ? 'UNEXPECTED: registered' : 'stops here (S1)'}: registering ${native} -> ${refused.status} ${refused.error ?? ''} ${refused.error_description ?? ''}`.trim());

  // What Kolab accepts today, as the CLI registers: a loopback redirect.
  const loopback = 'http://127.0.0.1/callback';
  const client = await register(discovery.registrationEndpoint!, loopback);
  if (!client.client_id) { log(`FAILED registering ${loopback}: ${client.status} ${client.error ?? ''}`); return; }
  log(`ok registered a loopback client (${client.client_id.slice(0, 5)}…)`);

  const request = (redirectUri: string) => new AuthRequest({
    clientId: client.client_id!, redirectUri, responseType: ResponseType.Code, usePKCE: true, codeChallengeMethod: CodeChallengeMethod.S256,
    scopes: ['konjir', 'team:hub', 'intent:join'], extraParams: { resource: mcpUrl },
  });

  const toNative = request(native);
  log(`ok AuthRequest with PKCE: ${showParams(await toNative.makeAuthUrlAsync(discovery))}`);
  log(`-- the auth session, redirect ${native} (not registered: Kolab can't send the code back)`);
  await prompt(toNative, discovery, holdMs, log);

  const toLoopback = request(loopback);
  await toLoopback.makeAuthUrlAsync(discovery);
  log(`-- the auth session, redirect ${loopback} (registered; the app can't receive it)`);
  await prompt(toLoopback, discovery, holdMs, log);
  log('oauth spike done');
}
