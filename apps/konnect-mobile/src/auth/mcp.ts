/**
 * An MCP client of Kolab for one team, over `expo/fetch` (whose responses stream, as
 * subscriptions/listen needs), sending the team's access token on every request. A request Kolab
 * refuses with 401 is sent once more with a renewed token. libs/konnect-client (another PR) will
 * hold the typed tool wrappers; this is only the connection.
 */
import { Client, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import { fetch as expoFetch } from 'expo/fetch';

export interface TokenSource {
  token(): Promise<string>;
  /** A token newer than the one Kolab refused. */
  renew(refused: string): Promise<string>;
}

const withBearer = (init: RequestInit | undefined, token: string): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
};

export async function teamClient(url: string, tokens: TokenSource): Promise<Client> {
  const send = (input: string | URL | Request, init: RequestInit | undefined) => expoFetch(String(input instanceof Request ? input.url : input), init as Parameters<typeof expoFetch>[1]) as unknown as Promise<Response>;
  const authed: FetchLike = async (input, init) => {
    const token = await tokens.token();
    const res = await send(input, withBearer(init, token));
    if (res.status !== 401) return res;
    return send(input, withBearer(init, await tokens.renew(token)));
  };
  // 'auto' negotiates the protocol version Kolab's subscriptions/listen needs, as konnect's CLI does.
  const client = new Client({ name: 'konnect-mobile', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: authed }));
  return client;
}
