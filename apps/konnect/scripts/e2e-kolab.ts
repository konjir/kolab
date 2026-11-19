// The Kolab apps/konnect/scripts/e2e.mjs talks to: one started from this checkout, on PGlite in
// the folder given, on a free 127.0.0.1 port, with the stub identity provider in GitHub's place,
// which never calls GitHub. Who signs in next is said on stdin, one line each: `next <subject>
// <login>`; `account <subject> <login>` adds a GitHub account konnect recruit can look up. It
// prints its MCP URL as one JSON line, {"url": …}, then `ok` after each line it takes. Kolab's own
// log lines, each MCP client that connects among them (event mcp_client), go to stdout too.
//
//   npx tsx --conditions=@konjir/source apps/konnect/scripts/e2e-kolab.ts <data folder>
import { createInterface } from 'node:readline';
import { StubIdentity, log, startServer } from '@konjir/server';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: e2e-kolab.ts <data folder>');
const idp = new StubIdentity();
const server = await startServer({ host: '127.0.0.1', port: 0, dataDir, adminToken: null, identity: idp, webRoot: null, clientLog: log });
console.log(JSON.stringify({ url: server.url }));
for await (const line of createInterface({ input: process.stdin })) {
  const [verb, subject, login] = line.trim().split(/\s+/);
  if (verb === 'next' && subject && login) idp.next({ subject, login });
  else if (verb === 'account' && subject && login) idp.account({ subject, login });
  else { console.log(`unknown: ${line}`); continue; }
  console.log('ok');
}
await server.close();
process.exit(0);
