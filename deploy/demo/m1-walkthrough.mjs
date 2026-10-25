#!/usr/bin/env node
// The M1 walkthrough: two teams put a small, real-looking product spec on a Kolab, end to end,
// through the konjir CLI, as an outside team would. See deploy/demo/DEMO.md.
//
//   KONJIR_URL=https://kolab.example.com/mcp KONJIR_TOKEN=<admin token> node deploy/demo/m1-walkthrough.mjs
//   node deploy/demo/m1-walkthrough.mjs cleanup <state file>
//
// It creates everything it uses under fresh names (organizations acme-<run> and globex-<run>, kolabs
// acme-demo-<run> and globex-demo-<run>, and their people and agents), so it never touches another
// kolab, the mirror kolab `kolab` included. It prints no token: the agents' tokens go to a state file
// readable only by you, which `cleanup` reads to end the sessions and archive what the run created.
//
// Settings (environment):
//   KONJIR_URL            the Kolab's MCP endpoint (default http://127.0.0.1:7420/mcp)
//   KONJIR_TOKEN          the admin token (or KONJIR_ADMIN_TOKEN)
//   KONJIR_BIN            the konjir command (default: this checkout's bin/konjir, else konjir on PATH);
//                         may hold arguments, e.g. "npx -y konjir@<version>" once published (always pinned)
//   KONJIR_DEMO_RUN       the suffix that keeps this run's names fresh (default: MMDD plus 4 random characters)
//   KONJIR_DEMO_STATE     where to write the state file (default ~/.konjir-demo/<run>.json)
//   KONJIR_DEMO_RULING    the Decisions Log id the ruling step applies (default D1)
//   KONJIR_DEMO_RESTART   optional: a shell command that restarts the Kolab, run while a version waits
//                         in review, to show the wait survives a restart (run-local.sh sets it)
//   KONJIR_DEMO_CLEANUP=1 clean up at the end of the run
//   NO_COLOR=1            plain output
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.KONJIR_URL ?? 'http://127.0.0.1:7420/mcp';
const ADMIN = process.env.KONJIR_ADMIN_TOKEN ?? process.env.KONJIR_TOKEN;
const BIN = (process.env.KONJIR_BIN ?? (existsSync(resolve(HERE, '../../bin/konjir')) ? resolve(HERE, '../../bin/konjir') : 'konjir')).split(' ').filter(Boolean);
const color = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s), dim = (s) => c('2', s), green = (s) => c('32', s), red = (s) => c('31', s), cyan = (s) => c('36', s);
const started = Date.now();

// ---- the konjir CLI ----------------------------------------------------------------------------

/** Who is acting, by name, and their token (never printed). */
const ADMIN_ACTOR = { name: 'admin', token: ADMIN };

/** Short, readable argument list for the narrative: arrays are summarized, long strings cut. */
function show(args) {
  return Object.entries(args).map(([k, v]) => {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.join().length < 40) return `${k}=${JSON.stringify(v)}`;
    if (Array.isArray(v)) return `${k}=[${v.length} ${k === 'deltas' ? 'delta' : k === 'links' ? 'link' : k === 'elements' ? 'element' : 'item'}${v.length === 1 ? '' : 's'}]`;
    if (k === 'token') return `${k}=<token>`;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const cut = s.length > 70 ? `${s.slice(0, 67)}...` : s;
    return `${k}=${/\s/.test(cut) ? JSON.stringify(cut) : cut}`;
  }).join(' ');
}

function run(who, verb, args = {}) {
  try {
    const out = execFileSync(BIN[0], [...BIN.slice(1), verb, '--json', JSON.stringify(args)], {
      env: { ...process.env, KONJIR_URL: URL_, KONJIR_TOKEN: who.token }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    try { return { ok: true, value: JSON.parse(out) }; } catch { return { ok: true, value: out.trim() }; }
  } catch (e) {
    // A refusal never carries a token into the narrative, whatever Kolab's message says.
    let error = String(e.stderr || e.message).trim();
    for (const t of [who.token, args.token, ADMIN]) if (t) error = error.replaceAll(t, '<token>');
    return { ok: false, error };
  }
}

/** Run a verb as `who`, print the command, and fail the walkthrough if it fails. */
function k(who, verb, args = {}, { quiet = false } = {}) {
  if (!quiet) console.log(`  ${cyan(who.name.padEnd(22))} ${dim('$')} konjir ${verb} ${dim(show(args))}`);
  const r = run(who, verb, args);
  if (!r.ok) fail(`konjir ${verb} as ${who.name} failed:\n${r.error}`);
  return r.value;
}

/** Run a verb that must be refused, and show the refusal. */
function refused(who, verb, args, why) {
  console.log(`  ${cyan(who.name.padEnd(22))} ${dim('$')} konjir ${verb} ${dim(show(args))}`);
  const r = run(who, verb, args);
  if (r.ok) fail(`expected Kolab to refuse ${verb} (${why}), but it did: ${JSON.stringify(r.value)}`);
  say(`refused, as it should be (${why}):`);
  say(dim(`"${r.error.split('\n')[0]}"`), 2);
  return r.error;
}

// ---- narrative -----------------------------------------------------------------------------------

let stepNo = 0;
function step(title, spec, lines = []) {
  stepNo++;
  console.log(`\n${bold(`== Step ${stepNo}. ${title}`)}  ${dim(`[${spec}]`)}`);
  for (const l of lines) console.log(`  ${l}`);
}
const say = (s, indent = 1) => console.log(`${'  '.repeat(indent)}${green('->')} ${s}`);
const checks = [];
function check(cond, what) {
  if (!cond) fail(`check failed: ${what}`);
  checks.push(what);
  console.log(`    ${green('ok')} ${what}`);
}
function fail(msg) {
  console.error(`\n${red('walkthrough stopped:')} ${msg}`);
  if (state) console.error(`State so far is in ${statePath}; clean up with: node ${rel(fileURLToPath(import.meta.url))} cleanup ${statePath}`);
  process.exit(1);
}
const rel = (p) => (p.startsWith(process.cwd() + '/') ? p.slice(process.cwd().length + 1) : p);

// ---- state: what this run created, so cleanup archives that and nothing else ----------------------

let state, statePath;
function save() {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

// ---- cleanup -------------------------------------------------------------------------------------

function cleanup(path) {
  const s = JSON.parse(readFileSync(path, 'utf8'));
  if (!ADMIN) fail('set KONJIR_TOKEN to the admin token');
  const admin = ADMIN_ACTOR;
  const url = process.env.KONJIR_URL ?? s.url;
  if (url !== s.url) fail(`the state file is for ${s.url}, not ${url}`);
  console.log(bold(`Cleaning up demo run ${s.run} on ${s.url}`));
  console.log('  Only what this run created: its sessions end, and its kolabs, organizations and actors are archived (D52).');
  let ended = 0, archived = 0;
  for (const x of s.sessions ?? []) {
    if (!x.token) continue;
    const r = run(admin, 'admin_end_session', { token: x.token });
    console.log(`  ${dim('$')} konjir admin_end_session token=<${x.actor}'s token>  ${r.ok ? green('ended') : dim(`(${r.error.split('\n')[0]})`)}`);
    if (r.ok) ended++;
  }
  // Each one by name, so each is archived in its own right and stays archived whatever happens to
  // its owner: the kolabs, then the organizations, then the agents and the people.
  const targets = [...s.kolabs.map((kolab) => ({ kolab })), ...s.orgs.map((organization) => ({ organization })), ...[...s.actors].reverse().map((actor) => ({ actor }))];
  for (const t of targets) {
    const [kind, name] = Object.entries(t)[0];
    const r = run(admin, 'admin_archive', t);
    console.log(`  ${dim('$')} konjir admin_archive ${kind}=${name}  ${r.ok ? green('archived') : dim(`(${r.error.split('\n')[0]})`)}`);
    if (r.ok) archived++;
  }
  console.log(`\n  Ended ${ended} session(s) and archived ${archived} of ${targets.length}.`);
  console.log(`  Nothing is deleted: an archived kolab, organization or actor is hidden from listings and can't be`);
  console.log(`  used, its data is kept, and its name stays reserved. admin_list_kolabs archived=true lists them;`);
  console.log(`  admin_unarchive restores one, with its grants and memberships.`);
  s.cleaned = new Date().toISOString();
  s.sessions = (s.sessions ?? []).map(({ actor }) => ({ actor, token: null }));
  writeFileSync(path, JSON.stringify(s, null, 2), { mode: 0o600 });
}

// ---- the walkthrough -------------------------------------------------------------------------------

function restartIfAsked() {
  const cmd = process.env.KONJIR_DEMO_RESTART;
  if (!cmd) return false;
  console.log(`  ${cyan('operator'.padEnd(22))} ${dim('$')} ${dim(`(restart Kolab) ${cmd.replaceAll(process.cwd() + '/', '')}`)}`);
  execSync(cmd, { stdio: ['ignore', 'ignore', 'inherit'] });
  const until = Date.now() + 60_000;
  for (;;) {
    if (run(ADMIN_ACTOR, 'admin_list_kolabs', { owner: state.orgs[0] }).ok) break;
    if (Date.now() > until) fail('Kolab did not come back within 60 s of the restart');
    execSync('sleep 0.5');
  }
  return true;
}

function main() {
  if (!ADMIN) fail('set KONJIR_TOKEN (or KONJIR_ADMIN_TOKEN) to the Kolab\'s admin token');
  const admin = ADMIN_ACTOR;
  const runId = (process.env.KONJIR_DEMO_RUN ?? `${String(new Date().getMonth() + 1).padStart(2, '0')}${String(new Date().getDate()).padStart(2, '0')}${randomBytes(3).toString('hex').slice(0, 4)}`).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,20}$/.test(runId)) fail(`KONJIR_DEMO_RUN must be lowercase letters, digits and -, not "${runId}"`);
  const ruling = process.env.KONJIR_DEMO_RULING ?? 'D1';
  statePath = resolve(process.env.KONJIR_DEMO_STATE ?? join(homedir(), '.konjir-demo', `${runId}.json`));

  const ACME = `acme-${runId}`, KOLAB = `acme-demo-${runId}`, GLOBEX = `globex-${runId}`, GKOLAB = `globex-demo-${runId}`;
  const priya = `priya-${runId}`, marco = `marco-${runId}`;
  const A = {
    pm: { name: `${priya}-drafter` }, pmReview: { name: `${priya}-reviewer` },
    eng: { name: `${marco}-builder` }, engReview: { name: `${marco}-reviewer` },
    globex: { name: `globex-${runId}-agent` },
  };
  const SPEC = 'invitations', BINDING = 'invitations-binding';
  const full = (node, rest = '') => `kj:${KOLAB}/${node}${rest}`;

  console.log(bold('Konjir M1 walkthrough: "an outside team could put a real product spec on it"'));
  console.log(`  Kolab:   ${URL_}`);
  console.log(`  konjir:  ${BIN.join(' ')}`);
  console.log(`  run:     ${runId} (every name below ends in it, so nothing existing is touched)`);
  console.log(`  state:   ${statePath} (mode 600: it holds the agents' tokens, which are never printed)`);

  // ---- 0. preflight
  const before = run(admin, 'admin_list_kolabs', { archived: true });   // an archived kolab's name is taken too
  if (!before.ok) fail(`the admin token doesn't work at ${URL_}:\n${before.error}`);
  const taken = before.value.kolabs.map((x) => x.id ?? x.name);
  for (const n of [KOLAB, GKOLAB]) if (taken.includes(n)) fail(`kolab ${n} already exists; pick another KONJIR_DEMO_RUN`);
  state = { run: runId, url: URL_, created: new Date().toISOString(), orgs: [], kolabs: [], actors: [], members: [], grants: [], sessions: [] };
  save();

  // ---- 1. tenancy
  step('Acme signs up: an organization, two people, a private kolab', 'TEN2, TEN6, TEN7, TEN8, TEN10', [
    `Priya is Acme's product manager; Marco is its engineer. The kolab ${KOLAB} belongs to the organization.`,
    'Each gets Write on one layer only: Priya the functional layer (the spec), Marco the technical layer (bindings).',
  ]);
  k(admin, 'admin_add_organization', { id: ACME, name: 'Acme Workspace, Inc.' }); state.orgs.push(ACME);
  for (const p of [priya, marco]) {
    k(admin, 'admin_add_actor', { id: p, name: p === priya ? 'Priya (product)' : 'Marco (engineering)' }); state.actors.push(p);
    k(admin, 'admin_add_member', { org: ACME, user: p }); state.members.push({ org: ACME, user: p });
  }
  k(admin, 'admin_add_kolab', { name: KOLAB, owner: ACME, title: 'Acme Workspace: team invitations' }); state.kolabs.push(KOLAB);
  k(admin, 'admin_grant', { kolab: KOLAB, to: priya, level: 'write', layers: ['functional'] }); state.grants.push({ kolab: KOLAB, to: priya });
  k(admin, 'admin_grant', { kolab: KOLAB, to: marco, level: 'write', layers: ['technical'] }); state.grants.push({ kolab: KOLAB, to: marco });
  save();

  step('Each person brings two agents, each an actor of its own', 'TEN11, VER16, D30', [
    'One agent of each person writes; the other reviews. Separation of duty is per agent, so a second agent',
    'of the same person is a valid reviewer. An agent never holds more than its owner: try to give Priya\'s agent',
    'the technical layer and Kolab refuses.',
  ]);
  for (const [a, owner, layer] of [[A.pm, priya, 'functional'], [A.pmReview, priya, 'functional'], [A.eng, marco, 'technical'], [A.engReview, marco, 'technical']]) {
    k(admin, 'admin_add_actor', { id: a.name, owner }); state.actors.push(a.name);
    k(admin, 'admin_grant', { kolab: KOLAB, to: a.name, level: 'write', layers: [layer] }); state.grants.push({ kolab: KOLAB, to: a.name });
  }
  save();
  refused(admin, 'admin_grant', { kolab: KOLAB, to: A.pm.name, level: 'write', layers: ['functional', 'technical'] }, "Priya can't write the technical layer, so her agent can't either");
  const acc = k(admin, 'admin_access', { actor: A.eng.name, kolab: KOLAB });
  say(`${A.eng.name} holds ${acc.level} on ${JSON.stringify(acc.layers)} in ${KOLAB}`);
  check(acc.level === 'write' && acc.layers.length === 1 && acc.layers[0] === 'technical', "the engineer's agent can write the technical layer only");

  step('Each agent gets a session: one kolab, one role, one token', 'ROL1, DEL1, DEL2, DEL4', [
    'The token is the whole setup a harness needs (Claude Code, Codex, a shell). It says who the agent is,',
    'which kolab it works in and which layer it may write; tool arguments never carry identity.',
  ]);
  for (const [a, role] of [[A.pm, 'product'], [A.pmReview, 'product'], [A.eng, 'engineer'], [A.engReview, 'engineer']]) {
    a.token = k(admin, 'admin_open_session', { actor: a.name, role, kolab: KOLAB }).token;
    state.sessions.push({ actor: a.name, token: a.token });
  }
  save();
  const me = k(A.eng, 'whoami');
  say(`${me.actor}, an agent of ${me.owner}, is ${me.role} on the ${me.layer} layer of ${me.kolab}; inboxes ${me.subscribe.join(', ')}`);
  check(me.kolab === KOLAB && me.layer === 'technical', 'the token alone fixes the kolab and the layer');

  // ---- 2. the spec, with one round of changes
  const R = {
    S1: 'Inviting people',
    R1: 'A workspace admin can invite a person to the workspace by entering their email address.',
    R2: 'The invited person receives an email with a link that accepts the invitation.',
    R3: 'An invitation expires 7 days after it is sent. Opening an expired link tells the person to ask the admin for a new invitation.',
    R4: 'A person who accepts an invitation joins with the Member role, unless the admin chose another role when inviting them.',
    S2: 'Managing invitations',
    R5: 'An admin can revoke a pending invitation. Opening a revoked link says the invitation is no longer valid.',
    R6: 'A workspace on the Free plan has at most 5 members, counting pending invitations.',
  };
  const spec = (over = {}) => Object.entries({ ...R, ...over }).map(([id, text]) => ({ id, text, ...(/^R[1-4]$/.test(id) ? { parent: 'S1' } : /^R[5-6]$/.test(id) ? { parent: 'S2' } : {}) }));
  step('Product drafts the functional spec and submits it for review', 'KON1, VER1, VER2, VER5, ADR1', [
    `Priya's drafting agent writes "Team invitations" for Acme Workspace: two sections, six requirements, each with`,
    'a stable ID. Its first draft slips: R3 says how expiry is built, not what the person sees.',
  ]);
  k(A.pm, 'create_node', { kind: 'spec', id: SPEC, title: 'Team invitations' });
  const v1 = k(A.pm, 'draft', { node: SPEC, elements: spec({ R3: 'An invitation expires 7 days after it is sent: a nightly cron job deletes expired rows from the invitations table.' }) });
  const s1 = k(A.pm, 'submit_for_review', { node: SPEC, version: v1.version });
  say(`${s1.in_review} is in review; review requests went to ${(s1.reviewers ?? []).join(', ')}`);
  check(s1.in_review && !s1.committed, 'nothing commits without review: the version waits, it is not truth yet');
  check((s1.reviewers ?? []).includes(A.pmReview.name) && (s1.reviewers ?? []).includes(priya), "Priya's other agent, and Priya herself, are its reviewers; Marco's agents are not (wrong layer)");

  step('A reviewer requests changes: implementation leaked into the spec', 'VER6, VER8, VER10, ROL3', [
    `${A.pmReview.name} works in its own harness, on its own model account: Kolab runs no model.`,
  ]);
  const inbox = k(A.pmReview, 'list_reviews');
  say(`waiting for ${A.pmReview.name}: ${inbox.for_you.map((x) => x.subject).join(', ')}`);
  k(A.pmReview, 'read_node', { node: SPEC, version: v1.version });
  const rc = k(A.pmReview, 'review', {
    node: SPEC, version: v1.version, verdict: 'request_changes',
    note: 'R3 says how expiry is implemented (a cron job, a table). Keep the spec to what the invited person experiences.',
    findings: [{ kind: 'layer_leak', elements: ['R3'], explanation: 'A nightly cron job and an invitations table are implementation; they belong in the binding.' }],
  });
  say(`verdict recorded; ${SPEC}@${v1.version} is back to ${rc.state}`);
  const back = k(A.pm, 'list_reviews');
  const mine = back.yours.find((x) => x.subject === `kj:${SPEC}@${v1.version}`);
  say(`the author's answers show: ${mine.state}, "${mine.verdicts.find((v) => v.state !== 'withdrawn')?.note ?? ''}"`);
  check(mine.state === 'drafted', 'a request for changes returns the version to its author as a draft');

  step('Product redrafts, abandons the first draft, and the reviewer approves', 'VER2, VER16', []);
  const v2 = k(A.pm, 'draft', { node: SPEC, elements: spec() });
  k(A.pm, 'abandon', { node: SPEC, version: v1.version });
  k(A.pm, 'submit_for_review', { node: SPEC, version: v2.version });
  const ap = k(A.pmReview, 'review', { node: SPEC, version: v2.version, verdict: 'approve', note: 'Six testable requirements, behavior only.' });
  const specV = Number(ap.committed.split('@')[1]);
  say(`committed: ${full(SPEC, `@${specV}`)} (short form inside the kolab: ${ap.committed})`);
  check(ap.ok && ap.committed, 'one approval from another agent of the same person commits the spec');

  step("Roles are enforced by Kolab, not by the agent's harness", 'ROL2, ROL5', []);
  refused(A.pm, 'create_node', { kind: 'binding', id: 'pm-binding', title: 'A binding by product' }, 'a product session cannot write the technical layer');
  refused(A.eng, 'draft', { node: SPEC, deltas: [{ kind: 'override', element: 'R6', text: 'A Free workspace has unlimited members.' }] }, 'an engineer session cannot change behavior');

  // ---- 3. the binding
  const B = {
    b1: 'POST /api/workspaces/:id/invitations inserts an invitations row (email, role, token_hash, sent_at, expires_at, revoked_at) and enqueues the invite email on the mail queue.',
    b2: 'expires_at = sent_at + interval \'7 days\'. GET /invite/:token answers 410 with the "ask your admin for a new invitation" page once now() > expires_at.',
    b3: 'POST /invite/:token/accept inserts a memberships row with the invitation\'s role (default \'member\') in the same transaction that marks the invitation accepted.',
    b4: 'DELETE /api/invitations/:id sets revoked_at; GET /invite/:token answers 410 with the "no longer valid" page when revoked_at is set.',
    b5: 'On a Free workspace, POST /api/workspaces/:id/invitations answers 402 when members + pending invitations >= 5, counted under SELECT ... FOR UPDATE on the workspace row.',
  };
  const binding = (over = {}) => Object.entries({ ...B, ...over }).map(([id, text]) => ({ id, text }));
  step('Engineering binds the spec to its stack, element by element', 'KON4, KON8, LNK1, LNK2, LNK3, ADR5, ADR6, VER4', [
    'Each binding element links to the requirement it serves; b4 links to the exact words "no longer valid" in R5',
    '(a quote with context, not a whole element). Links pin the committed version and a fingerprint of their target.',
  ]);
  k(A.eng, 'create_node', { kind: 'binding', id: BINDING, title: 'Team invitations on Node, Postgres and the mail queue' });
  const span = (el, exact, prefix, suffix) => `kj:${SPEC}@${specV}#${el}~q(${JSON.stringify({ exact, prefix, suffix })})`;
  const bd = k(A.eng, 'draft', {
    node: BINDING, elements: binding(), links: [
      { source_element: 'b1', target: `kj:${SPEC}@${specV}#R1` },
      { source_element: 'b1', target: `kj:${SPEC}@${specV}#R2` },
      { source_element: 'b2', target: `kj:${SPEC}@${specV}#R3` },
      { source_element: 'b3', target: `kj:${SPEC}@${specV}#R4` },
      { source_element: 'b4', target: span('R5', 'no longer valid', 'link says the invitation is ', '.') },
      { source_element: 'b5', target: `kj:${SPEC}@${specV}#R6` },
    ],
  });
  for (const l of bd.linked) say(l, 2);
  k(A.eng, 'submit_for_review', { node: BINDING, version: bd.version });
  const bap = k(A.engReview, 'review', { node: BINDING, version: bd.version, verdict: 'approve', note: 'Each element serves the requirement it links to, no more and no less.' });
  let bindingV = Number(bap.committed.split('@')[1]);
  say(`committed: ${full(BINDING, `@${bindingV}`)}`);
  check(bap.ok, "Marco's reviewer agent approves the binding");
  const down = k(A.pm, 'lineage', { node: SPEC, direction: 'downstream' });
  say(`what relies on the spec now: ${down.edges.length} links, from ${[...new Set(down.edges.map((e) => e.source.split('#')[0]))].join(', ')}`);
  check(down.edges.length === 6, 'the spec sees all six links that rely on it');

  // ---- 4. questions and notes across layers
  step('Engineering asks product a question, and leaves a note', 'Q1, Q2, Q3, Q4, Q5, Q6', [
    'A question blocks the element that waits on it until product answers. A note records an assumption the',
    'engineer goes ahead with; it blocks nothing, but waits in product\'s queue so product can object.',
  ]);
  const q = k(A.eng, 'ask', { address: `kj:${SPEC}#R5`, question: 'When an admin revokes an invitation, should the invited person get an email saying so?', from: `kj:${BINDING}@${bindingV}#b4` });
  const n = k(A.eng, 'annotate', { address: span('R3', '7 days', 'An invitation expires ', ' after it is sent.').replace(`@${specV}`, ''), note: 'Reading "7 days" as 168 hours from the moment the email is sent, not 7 calendar days in the workspace\'s time zone.', from: `kj:${BINDING}@${bindingV}#b2` });
  const pq = k(A.pm, 'list_queries');
  for (const x of pq.queries) say(`${x.kind} on ${x.address}, from ${x.from}: "${x.question}"`, 2);
  check(pq.queries.some((x) => x.id === q.query) && pq.queries.some((x) => x.id === n.note), "both reach the functional layer's queue: the spec owns the answer");
  k(A.pm, 'answer_query', { query: q.query, answer: 'No email. The link simply stops working and shows that the invitation is no longer valid.' });
  k(A.pm, 'answer_query', { query: n.note, answer: 'Agreed: 168 hours from sending.' });
  const em = k(A.eng, 'list_stale');
  for (const m of em.marks) say(`${m.reason} on ${m.dirty}: ${m.because}`, 2);
  const qa = em.marks.find((m) => m.reason === 'query_answered');
  check(em.marks.length === 1 && qa && qa.dirty.endsWith('#b4'), 'the answer marks exactly the element that waited on it (b4); the reply to the note marks nothing');
  k(A.eng, 'clear_mark', { mark: qa.mark });
  say('b4 already sends no email, so the engineer confirms it holds and clears the mark');
  const read = k(A.pm, 'read_node', { node: SPEC });
  const r5 = read.elements.find((e) => e.id === 'R5');
  say(`read_node shows the thread beside R5: ${r5.questions.length} question, ${r5.questions[0].state}, answered by ${r5.questions[0].answered_by}`);
  check(r5.questions[0].state === 'answered', 'questions stay beside the element they concern, with their answers');

  // ---- 5. a spec change cascades
  step('Product changes the spec: invitations now last 14 days', 'LNK3, LNK4, LNK5, ADR8, VER2', [
    'R3 changes and nothing else does. Kolab re-checks every link into the spec against the new version.',
  ]);
  const c1 = k(A.pm, 'draft', { node: SPEC, deltas: [{ kind: 'override', element: 'R3', text: R.R3.replace('7 days', '14 days') }] });
  k(A.pm, 'submit_for_review', { node: SPEC, version: c1.version });
  const c1a = k(A.pmReview, 'review', { node: SPEC, version: c1.version, verdict: 'approve' });
  say(`committed ${c1a.committed}`);
  const st = k(A.eng, 'list_stale');
  for (const m of st.marks) say(`${m.reason} on ${m.dirty}: ${m.because}`, 2);
  check(st.marks.length === 1 && st.marks[0].dirty.endsWith('#b2'), 'exactly one binding element is marked (b2, which serves R3); b1, b3, b4 (its quote unchanged) and b5 re-pinned silently');

  step('Engineering resolves the mark by revising b2', 'LNK6, LNK7', [
    'Revising the marked element in a new version settles its mark and re-pins its link to R3 as it is now.',
  ]);
  const newSpecV = Number(c1a.committed.split('@')[1]);
  const b2v = k(A.eng, 'draft', {
    node: BINDING, deltas: [{ kind: 'override', element: 'b2', text: B.b2.replace("'7 days'", "'14 days'") }],
  });
  k(A.eng, 'submit_for_review', { node: BINDING, version: b2v.version });
  const b2a = k(A.engReview, 'review', { node: BINDING, version: b2v.version, verdict: 'approve' });
  bindingV = Number(b2a.committed.split('@')[1]);
  say(`committed ${full(BINDING, `@${bindingV}`)}`);
  const st2 = k(A.eng, 'list_stale');
  check(st2.marks.length === 0, 'the technical layer has no open marks');

  // ---- 6. a ruling
  step(`A ruling: Acme raises the Free plan to 10 members (${ruling})`, 'CASE3, D47', [
    `Acme's leadership decided it; there is nothing to review. The admin applies the ruling as Priya, who holds Write`,
    `on the functional layer. It commits after structural checks alone, its review note naming ${ruling}.`,
    'Only the admin token reaches this verb; an agent session is refused, so no agent can skip review with it.',
  ]);
  refused(A.pm, 'admin_apply_ruling', { ruling, actor: priya, node: `${KOLAB}/${SPEC}`, deltas: [{ kind: 'override', element: 'R6', text: 'x' }] }, 'agent sessions cannot apply rulings');
  const rl = k(admin, 'admin_apply_ruling', { ruling, actor: priya, node: `${KOLAB}/${SPEC}`, deltas: [{ kind: 'override', element: 'R6', text: R.R6.replace('at most 5', 'at most 10') }] });
  say(`committed ${rl.committed}; review note: "${rl.review}"`);
  check(rl.ok && rl.committed === full(SPEC, rl.committed.slice(rl.committed.indexOf('@'))), 'the ruling commits, named by its full address');
  const rv = k(A.eng, 'read_node', { node: SPEC });
  say(`${SPEC}@${rv.version} was written by ${rv.author?.actor ?? JSON.stringify(rv.author)} in the ${rv.author?.role ?? '?'} role`);
  const st3 = k(A.eng, 'list_stale');
  for (const m of st3.marks) say(`${m.reason} on ${m.dirty}: ${m.because}`, 2);
  check(st3.marks.length === 1 && st3.marks[0].dirty.endsWith('#b5'), 'the ruling cascades like any commit: b5 is marked');
  const b5v = k(A.eng, 'draft', { node: BINDING, deltas: [{ kind: 'override', element: 'b5', text: B.b5.replace('>= 5', '>= 10') }] });
  k(A.eng, 'submit_for_review', { node: BINDING, version: b5v.version });
  const b5a = k(A.engReview, 'review', { node: BINDING, version: b5v.version, verdict: 'approve' });
  bindingV = Number(b5a.committed.split('@')[1]);
  check(k(A.eng, 'list_stale', {}, { quiet: true }).marks.length === 0, 'b5 revised and approved; no marks left');

  // ---- 7. a wait that survives a restart (optional)
  step('A review that waits across a server restart, and a mark confirmed without an edit', 'VER16, LNK6, REV3', [
    'Product rewords R2. The review request is a row in the database, not a message in flight, so it waits',
    'for its reviewer however long that takes, and survives the server going away.',
  ]);
  const w = k(A.pm, 'draft', { node: SPEC, deltas: [{ kind: 'override', element: 'R2', text: 'The invited person receives an email with a link that accepts the invitation, sent from the workspace\'s name.' }] });
  k(A.pm, 'submit_for_review', { node: SPEC, version: w.version });
  if (restartIfAsked()) say('Kolab restarted while the version waited in review; every session token still works');
  else say(dim('(no KONJIR_DEMO_RESTART set: skipping the restart itself; deploy/demo/run-local.sh sets it)'));
  const after = k(A.pmReview, 'list_reviews');
  check(after.for_you.some((x) => x.subject === `kj:${SPEC}@${w.version}`), `the review request for ${SPEC}@${w.version} is still in ${A.pmReview.name}'s inbox`);
  k(A.pmReview, 'review', { node: SPEC, version: w.version, verdict: 'approve' });
  const st4 = k(A.eng, 'list_stale');
  for (const m of st4.marks) say(`${m.reason} on ${m.dirty}: ${m.because}`, 2);
  check(st4.marks.length === 1 && st4.marks[0].dirty.endsWith('#b1'), 'b1, which links to R2, is marked');
  k(A.eng, 'clear_mark', { mark: st4.marks[0].mark });
  say('the sender name changes nothing the binding states, so the engineer confirms b1 still holds');
  const ob = k(admin, 'admin_outbox');
  say(`the outbox holds ${ob.jobs.length} job(s) across the whole Kolab${ob.jobs.length ? `: ${ob.jobs.map((j) => `${j.kind ?? '?'} ${j.state ?? ''}`).join(', ')}` : ''}`);
  check(!ob.jobs.some((j) => j.state === 'dead'), 'no outbox job is dead: every commit and verdict did the work it owed');

  // ---- 8. isolation
  step('A second company, Globex, gets a kolab of its own', 'TEN3, TEN4, TEN11, TEN12, ADR3, VER11', [
    'Globex runs one agent that the organization itself owns, and it happens to write a spec with the same name.',
    'Names are unique per kolab, so neither learns of the other, and nothing in Acme\'s kolab can be seen from',
    'Globex\'s, not even whether it exists.',
  ]);
  k(admin, 'admin_add_organization', { id: GLOBEX, name: 'Globex Corporation' }); state.orgs.push(GLOBEX);
  k(admin, 'admin_add_kolab', { name: GKOLAB, owner: GLOBEX }); state.kolabs.push(GKOLAB);
  k(admin, 'admin_add_actor', { id: A.globex.name, owner: GLOBEX }); state.actors.push(A.globex.name);
  k(admin, 'admin_grant', { kolab: GKOLAB, to: A.globex.name, level: 'write', layers: ['functional'] }); state.grants.push({ kolab: GKOLAB, to: A.globex.name });
  A.globex.token = k(admin, 'admin_open_session', { actor: A.globex.name, role: 'product', kolab: GKOLAB }).token;
  state.sessions.push({ actor: A.globex.name, token: A.globex.token });
  save();
  refused(admin, 'admin_add_kolab', { name: KOLAB, owner: GLOBEX }, 'a kolab name is unique across all of Konjir');
  k(A.globex, 'create_node', { kind: 'spec', id: SPEC, title: 'Globex invitations' });
  const gd = k(A.globex, 'draft', { node: SPEC, elements: [{ id: 'G1', text: 'A Globex manager can invite a contractor for a fixed number of days.' }] });
  const gs = k(A.globex, 'submit_for_review', { node: SPEC, version: gd.version });
  say(`committed ${gs.committed} in ${GKOLAB}${gs.unreviewed ? ', unreviewed: no one else at Globex holds Write on the layer' : ''}`);
  check(gs.ok && gs.unreviewed, 'with no other writer on the layer, structural checks alone commit it, and the commit says so (VER11)');
  const gl = k(A.globex, 'list_nodes');
  say(`Globex's agent lists: ${gl.map((x) => `${x.id} (${x.title})`).join(', ')}`);
  check(gl.length === 1 && gl[0].title === 'Globex invitations', "Globex's agent sees only its own kolab's nodes");
  const e1 = refused(A.globex, 'read_node', { node: `${KOLAB}/${SPEC}` }, "Globex holds no Read on Acme's kolab");
  const e2 = run(A.globex, 'read_node', { node: `no-such-kolab-${runId}/${SPEC}` });
  const norm = (s) => s.replaceAll(KOLAB, '<kolab>').replaceAll(`no-such-kolab-${runId}`, '<kolab>');
  check(!e2.ok && norm(e1) === norm(e2.error), "the refusal reads exactly like a kolab that doesn't exist: nothing leaks");
  refused(A.globex, 'resolve', { address: full(SPEC, '#R3') }, 'addresses into an unreadable kolab do not resolve');
  refused(A.eng, 'read_node', { node: `${GKOLAB}/${SPEC}` }, 'and the other way round');
  const mineNow = k(A.pm, 'read_node', { node: SPEC }, { quiet: true });
  check(mineNow.elements.length === 8 && mineNow.elements.every((e) => !/Globex/.test(e.text)), "Acme's spec is untouched by Globex's spec of the same name");

  // ---- summary
  const fin = k(A.eng, 'read_node', { node: BINDING });
  const finSpec = k(A.eng, 'read_node', { node: SPEC }, { quiet: true });
  step('Where things stand', 'PLN7 (not built yet), ADR9', []);
  say(`${full(SPEC, `@${finSpec.version}`)}: ${finSpec.elements.length} elements, last written by ${finSpec.author?.actor}`);
  say(`${full(BINDING, `@${fin.version}`)}: ${fin.elements.length} elements, last written by ${fin.author?.actor}, no open marks`);
  for (const e of finSpec.elements.filter((x) => /^R/.test(x.id))) say(dim(`${e.address}  ${e.text}`), 2);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${bold(`Done: ${checks.length} checks passed in ${secs} s.`)}`);
  console.log(`  State (with the agents' tokens, mode 600): ${statePath}`);
  if (process.env.KONJIR_DEMO_CLEANUP === '1') { console.log(''); cleanup(statePath); }
  else console.log(`  Clean up with: KONJIR_URL=${URL_} KONJIR_TOKEN=<admin token> node ${rel(fileURLToPath(import.meta.url))} cleanup ${statePath}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'cleanup') {
  if (!arg) { console.error('usage: m1-walkthrough.mjs cleanup <state file>'); process.exit(2); }
  cleanup(resolve(arg));
} else if (cmd === undefined) {
  main();
} else {
  console.error('usage: m1-walkthrough.mjs            run the walkthrough\n       m1-walkthrough.mjs cleanup <state file>');
  process.exit(2);
}
