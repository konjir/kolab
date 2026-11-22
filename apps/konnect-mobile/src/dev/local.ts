/**
 * Where scripts/local-kolab.mts hands a dev build what it needs to talk to the Kolab it started:
 * its MCP URL and two people's throwaway access tokens, on 127.0.0.1 only, which a simulator
 * shares with this machine.
 */
import type { SpikeTokens } from './mcp-spike';

export const LOCAL_HANDOFF = 'http://127.0.0.1:7433/spike';

export async function localKolab(from = LOCAL_HANDOFF): Promise<SpikeTokens> {
  const res = await fetch(from);
  if (!res.ok) throw new Error(`${from} answered ${res.status}: is scripts/local-kolab.mts running?`);
  return await res.json() as SpikeTokens;
}
