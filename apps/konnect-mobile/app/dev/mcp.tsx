import { useCallback } from 'react';
import { localKolab } from '@/dev/local';
import { LogScreen } from '@/dev/LogScreen';
import { runMcpSpike } from '@/dev/mcp-spike';

/** Phase 0: the MCP client on Hermes, with expo/fetch, against scripts/local-kolab.mts. */
export default function McpSpike() {
  const run = useCallback(async (log: (l: string) => void) => runMcpSpike(await localKolab(), log), []);
  return <LogScreen title="MCP spike" tag="mcp-spike" run={run} />;
}
