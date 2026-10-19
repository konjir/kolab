/**
 * A Kolab that signs people in through its own authorization server (D55), for the end-to-end test
 * of signing in from a real browser (e2e/sign-in.spec.ts): the stub identity provider in place of
 * GitHub, which signs in someone new each time (newcomer1, newcomer2, …), and the kolab `accounts`,
 * Lee's, with an invite to it whose link the test opens.
 *
 *   PORT=7433 KONJIR_SIGNIN_INVITE=/path/invite.txt npm run signin-demo
 *
 * It stores in memory, and writes the invite's secret to a file only its user can read.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Kolab } from '@konjir/engine';
import { StubIdentity, startServer } from '@konjir/server';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 7433);
const inviteFile = process.env.KONJIR_SIGNIN_INVITE ?? join(here, '..', '.konjir-demo', 'invite.txt');

/** The stub provider, signing in a new person each time it is asked. */
class Newcomers extends StubIdentity {
  private k = 0;
  override authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string }) {
    this.k++;
    this.next({ subject: `e2e-${this.k}`, login: `newcomer${this.k}` });
    return super.authorizationUrl(p);
  }
}

const kolab = await Kolab.open({});
await kolab.addActor('lee', { name: 'Lee' });
await kolab.createKolab('accounts', { owner: 'lee', title: 'Accounts' });
const lee = await kolab.openSession('lee', 'product', { kolab: 'accounts' });
const { token } = await kolab.createInvite(lee, { level: 'write', layers: ['technical'] });
await kolab.endSession(lee);

const server = await startServer({ kolab, port, adminToken: randomBytes(24).toString('base64url'), identity: new Newcomers() });
mkdirSync(dirname(inviteFile), { recursive: true });
writeFileSync(inviteFile, token, { mode: 0o600 });
chmodSync(inviteFile, 0o600);
console.log(`Kolab sign-in demo: ${new URL(server.url).origin}/ (an invite to accounts in ${inviteFile})`);
const stop = async () => { await server.close(); await kolab.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
