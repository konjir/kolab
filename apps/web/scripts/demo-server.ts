/**
 * A Kolab with the example the Konjir Kolab prototype simulates (W3.1), for trying the web
 * interface and for its end-to-end test: the kolab `accounts`, owned by Lee, with the password
 * reset spec at version 3 (PR8 tightened to 3 an hour), its Postgres binding at version 2 (B9 stale
 * against PR8), two answered questions and one open one, on PR3. Lee owns the kolab; pm-agent,
 * eng-agent and qa-agent are agents of Lee's, with Write on one layer each, who wrote its history
 * through the engine as agents do through MCP. Pat (product) and Eli (engineering) are people with
 * Write on one layer each, so a person reviews what Lee submits, and a person settles the binding.
 * A second kolab, `checkout`, also Lee's, holds the prototype's checkout spec at version 2, with a
 * question on R5 and a draft of version 3, for reading another kolab's committed work in place (D49).
 *
 *   npx nx run @konjir/web:demo                        # builds the page, serves http://127.0.0.1:7421
 *   PORT=7430 KONJIR_DEMO_TOKENS=/path/tokens.json …   # another port, or another place for the tokens
 *
 * It stores in memory, and writes each actor's session token to a file only its user can read
 * (by default .konjir-demo/tokens.json under this app), and prints the file's path, never a token.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Kolab } from '@konjir/engine';
import { ADMIN_DOER } from '@konjir/types';
import { startServer } from '@konjir/server';
import type { ElementInput, GateResult } from '@konjir/types';

/** The seed is the admin's setup: every write it makes names the admin token (W2.20). */
const admin = { by: ADMIN_DOER };

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 7421);
const tokensFile = process.env.KONJIR_DEMO_TOKENS ?? join(here, '..', '.konjir-demo', 'tokens.json');

const specV2: Record<string, string> = {
  PR1: 'A user who has forgotten their password can request a reset link by entering their email address.',
  PR2: 'If the email belongs to an account, a reset link is sent to it.',
  PR3: 'The request page shows the same response whether or not the email belongs to an account.',
  PR4: 'Opening a valid link lets the user choose a new password. The old password stops working immediately.',
  PR5: 'A reset link expires 30 minutes after it is issued. An expired link tells the user it is no longer valid and offers to send a new one.',
  PR6: 'A link works once. Only the newest link is valid: issuing a new link invalidates earlier ones, and a successful reset invalidates all outstanding links.',
  PR7: 'A successful reset signs the user in with a new session. Every session that existed before the reset is signed out.',
  PR8: 'At most 5 reset requests per email address per hour. Requests over the limit get the same response as PR3.',
};
const specV1 = { ...specV2, PR6: 'A link works once.', PR7: 'After a successful reset, all of the user\'s other sessions are signed out.' };
const bindV2: Record<string, string> = {
  B1: 'POST /password-reset/request. Normalizes the email (trim, lowercase) before any lookup.',
  B2: 'Reset tokens are 32 random bytes, base64url-encoded, sent only inside the emailed link.',
  B3: 'Only a SHA-256 hash of each token is stored, in the reset_tokens table in Postgres.',
  B4: 'expires_at = now() + interval \'30 minutes\', set by the database clock, never the app server\'s.',
  B5: 'Redeeming is one atomic UPDATE … RETURNING that locks the user\'s live tokens, so two redemptions can\'t both succeed. A successful reset also invalidates the user\'s other live tokens.',
  B6: 'Invalid, expired, used and superseded links all show "This link is no longer valid" with a button to send a new one.',
  B7: 'The new password is hashed with argon2id and replaces the old hash in the same transaction.',
  B8: 'Revoke sessions from before the reset: delete them from Redis and set users.sessions_valid_after = now().',
  B9: 'Rate limit: a Redis sliding window allowing 5 requests per normalized email per hour.',
  B10: 'The request always returns 202 with the same body; token creation and email sending happen in a background job.',
  B11: 'An email worker sends through the provider API, retrying 3 times with backoff.',
  B12: 'Issuing a token invalidates the earlier ones: a partial unique index allows one live token per user.',
  B13: 'After revoking old sessions, create a new session and set its cookie on the response.',
};
const bindV1: Record<string, string> = {
  ...Object.fromEntries(Object.entries(bindV2).filter(([k]) => k !== 'B12' && k !== 'B13')),
  B5: 'Redeeming is one atomic UPDATE … RETURNING, so a token works exactly once.',
  B6: 'Invalid, expired and used links all show "This link is no longer valid" with a button to send a new one.',
  B8: 'Revoke the user\'s sessions in Redis and set users.sessions_valid_after = now(). (Which session survives is waiting on a question about PR7.)',
};
const serves: Record<string, string[]> = {
  B1: ['PR1'], B2: ['PR2', 'PR4'], B3: ['PR4'], B4: ['PR5'], B5: ['PR6'], B6: ['PR4', 'PR5', 'PR6'], B7: ['PR4'],
  B8: ['PR7'], B9: ['PR8'], B10: ['PR3', 'PR8'], B11: ['PR2'], B12: ['PR6'], B13: ['PR7'],
};
const els = (o: Record<string, string>): ElementInput[] => Object.entries(o).map(([id, text]) => ({ id, text }));

const checkoutV2: Record<string, string> = {
  R1: 'A signed-in user can pay for the items in their cart with a saved card or a new one.',
  R2: 'The total shown on the review page is the amount charged, including tax and shipping.',
  R3: 'Pressing Pay more than once, or retrying after a timeout, charges the card once.',
  R4: 'If a payment fails, the cart is kept and the user sees why in plain words.',
  R5: 'A receipt email is sent within a minute of a successful payment.',
};
const checkoutV1 = { ...checkoutV2, R3: 'A payment is never taken twice.' };

export async function seed(kolab: Kolab) {
  await kolab.addActor('lee', { name: 'Lee', ...admin });
  await kolab.createKolab('accounts', { owner: 'lee', title: 'Accounts', ...admin });
  for (const [agent, layer] of [['pm-agent', 'functional'], ['eng-agent', 'technical'], ['qa-agent', 'technical']] as const) {
    await kolab.addActor(agent, { owner: 'lee', ...admin });
    await kolab.grant('accounts', agent, 'write', { layers: [layer], ...admin });
  }
  for (const [person, name, layer] of [['pat', 'Pat', 'functional'], ['eli', 'Eli', 'technical']] as const) {
    await kolab.addActor(person, { name, ...admin });
    await kolab.grant('accounts', person, 'write', { layers: [layer], ...admin });
  }
  // Checkout, Lee's other kolab: its spec at version 2, a question from eng-agent, and Lee's draft of
  // version 3, which a reader from another kolab never sees. Each actor holds one open session at a
  // time (ENF4), so these end before the accounts sessions open.
  await kolab.createKolab('checkout', { owner: 'lee', title: 'Checkout', ...admin });
  await kolab.grant('checkout', 'eng-agent', 'write', { layers: ['technical'], ...admin });
  const leeThere = await kolab.openSession('lee', 'product', { kolab: 'checkout', ...admin });
  await kolab.createNode(leeThere, 'functional_spec', 'Checkout', 'checkout');
  await kolab.commit(leeThere, 'checkout', { elements: els(checkoutV1) });
  await kolab.commit(leeThere, 'checkout', { elements: els(checkoutV2) });
  const engThere = await kolab.openSession('eng-agent', 'engineer', { kolab: 'checkout', ...admin });
  await kolab.raiseQuery(engThere, 'kj:checkout#R5', 'R5 says within a minute. If the email provider is down, should the receipt be retried until it sends, or is a late receipt a failure someone should hear about?');
  await kolab.draft(leeThere, 'checkout', { elements: els({ ...checkoutV2, R5: 'A receipt email is sent within five minutes of a successful payment.' }) });
  await kolab.endSession(engThere, { signingOut: true });
  await kolab.endSession(leeThere, { signingOut: true });

  const pm = await kolab.openSession('pm-agent', 'product', { kolab: 'accounts', ...admin });
  const eng = await kolab.openSession('eng-agent', 'engineer', { kolab: 'accounts', ...admin });
  const qa = await kolab.openSession('qa-agent', 'engineer', { kolab: 'accounts', ...admin });
  const lee = await kolab.openSession('lee', 'product', { kolab: 'accounts', ...admin });

  /** Draft and submit as `author`, and approve as `reviewer` if it waits in review. */
  const commit = async (author: string, reviewer: string, node: string, elements: ElementInput[]) => {
    let r: GateResult = await kolab.submit(author, await kolab.draft(author, node, { elements }));
    if (r.in_review) r = await kolab.recordReview(reviewer, r.version, { verdict: 'approve', note: 'Each element states one testable intent; nothing contradicts.' });
    if (!r.ok) throw new Error(`${node} didn't commit: ${r.note ?? ''}`);
    return r.version;
  };
  const link = async (version: string, only?: string[]) => {
    const spec = (await kolab.latestCommitted('password-reset'))!.id;
    for (const [b, prs] of Object.entries(serves)) {
      if (only && !only.includes(b)) continue;
      for (const pr of prs) await kolab.link(eng, { kind: 'dependency', source: version, sourceElement: b, target: spec, targetElement: pr });
    }
  };

  await kolab.createNode(pm, 'functional_spec', 'Password reset', 'password-reset');
  await commit(pm, lee, 'password-reset', els(specV1));
  await kolab.createNode(eng, 'technical_binding', 'Password reset on Postgres', 'password-reset-pg');
  const b1 = await commit(eng, qa, 'password-reset-pg', els(bindV1));
  await link(b1);
  const q1 = await kolab.raiseQuery(eng, 'kj:password-reset#PR7', 'PR7 says "all of the user\'s other sessions" are signed out. Other than which session? Should a successful reset sign the user in with a new session that survives, or leave them signed out with every session revoked?', { from: 'kj:password-reset-pg#B8' });
  const q2 = await kolab.raiseQuery(eng, 'kj:password-reset#PR6', 'If a user requests several resets, does a new link (or a completed reset) invalidate the other unexpired links? PR6 only says a link works once.');
  await kolab.answerQuery(pm, q1, 'Sign in, revoke the rest: a successful reset signs the user in with a new session, and every session that existed before the reset is revoked. PR7 is amended in v2.');
  await kolab.answerQuery(pm, q2, 'Only the newest link is valid. Issuing a new link invalidates earlier ones, and a successful reset invalidates all outstanding links. PR6 is amended in v2.');
  await commit(pm, lee, 'password-reset', els(specV2));
  const b2 = await commit(eng, qa, 'password-reset-pg', els(bindV2));
  await link(b2, ['B12', 'B13']);
  // What v2 of the spec marked and the binding's v2 didn't revise still holds against it.
  for (const m of await kolab.describeMarks({ layer: 'technical', kolab: 'accounts' })) await kolab.clear(eng, m.mark);
  await commit(lee, pm, 'password-reset', els({ ...specV2, PR8: 'At most 3 reset requests per email address per hour. Requests over the limit get the same response as PR3.' }));
  await kolab.raiseQuery(eng, 'kj:password-reset#PR3', 'PR3 says the response is the same whether or not the email belongs to an account. Should the response time be indistinguishable too? Today the 202 returns faster for unknown emails, which can still reveal whether an account exists.');
  // The people's sessions, for the web interface; the agents' stay with the agents.
  return {
    lee, pat: await kolab.openSession('pat', 'product', { kolab: 'accounts', ...admin }), eli: await kolab.openSession('eli', 'engineer', { kolab: 'accounts', ...admin }),
  };
}

async function main() {
  const kolab = await Kolab.open({});
  const sessions = await seed(kolab);
  const server = await startServer({ kolab, port, adminToken: randomBytes(24).toString('base64url') });
  kolab.startWorker();
  mkdirSync(dirname(tokensFile), { recursive: true });
  writeFileSync(tokensFile, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  chmodSync(tokensFile, 0o600);
  const origin = new URL(server.url).origin;
  console.log(`Kolab demo: ${origin}/ (sign in with a person's token from ${tokensFile}: lee, pat or eli)`);
  const stop = async () => { await server.close(); await kolab.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
