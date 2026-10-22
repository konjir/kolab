// Questions and notes across the layer boundary: the engineer asks or
// annotates the spec, the answer comes back to the element that waited on it,
// and every inbox change is pushed to subscribed agents.
import { expect, test } from '@jest/globals';
import { Kolab, RoleError, sessionKey } from '@konjir/engine';
import { nobodyCanReview, type KolabEvent } from '@konjir/types';
import { startServer } from '@konjir/server';
import { call, connect, watch } from '../src/cli.js';
import { closeAtEnd, els, marksOn, people, persistentStore, setup, rejection, testStore } from '@konjir/engine/testing';

async function specAndBinding() {
  const ctx = await setup();
  const { kolab, product, engineer } = ctx;
  await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
  await kolab.commit(product, 'orders', { elements: els({
    R8: 'Office staff can cancel an order.',
    R13: 'Photos taken more than 50 meters from the property are flagged.',
  }) });
  await kolab.createNode(engineer, 'technical_binding', 'Orders on Postgres', 'orders-pg');
  const draft = await kolab.draft(engineer, 'orders-pg', { elements: els({
    b1: 'orders.status allows cancel from Open and Assigned (pending a spec question).',
    b2: 'Photo GPS distance check in the mobile app.',
  }) });
  return { ...ctx, draft };
}

test('a question asked from a binding element comes back to that element as a mark', async () => {
  const { kolab, product, engineer, draft } = await specAndBinding();
  const events: KolabEvent[] = [];
  kolab.onEvent((e) => events.push(e));

  // Asked while the binding is still a draft, about a quoted span.
  const q = await kolab.raiseQuery(engineer, 'kj:orders#R8~q({"exact":"cancel an order"})',
    'From which statuses, and what happens to its invoices?', { from: 'kj:orders-pg@1#b1' });
  expect(events).toStrictEqual([{ inbox: 'layer', kolab: 'test', layer: 'functional' }]);
  expect((await kolab.review(draft)).ok).toBe(true);

  const [listed] = await kolab.listQueries({ layer: 'functional', state: 'open' });
  expect([listed.id, listed.kind, listed.address, listed.from, listed.raised_by]).toStrictEqual([q, 'question', 'kj:orders@1#R8~q({"exact":"cancel an order"})', 'kj:orders-pg@1#b1', 'bob']);

  // Only the owning layer answers. The answer marks b1, not b2, and tells the asker.
  await expect(kolab.answerQuery(engineer, q, 'any time')).rejects.toBeInstanceOf(RoleError);
  events.length = 0;
  await kolab.answerQuery(product, q, 'Open or Assigned only; invoices are voided.');
  const [mark] = await marksOn(kolab, 'orders-pg');
  expect([mark.reason, mark.element_id]).toStrictEqual(['query_answered', 'b1']);
  expect(mark.note!).toMatch(/you asked "From which statuses.*answered: "Open or Assigned only/);
  expect((await kolab.describeMarks({ layer: 'technical' })).map((m) => [m.dirty, m.because.slice(0, 15)])).toStrictEqual([['kj:orders-pg@1#b1', 'kj:orders#R8: y']]);
  expect(new Set(events.map((e) => JSON.stringify(e)))).toStrictEqual(new Set([
    JSON.stringify({ inbox: 'layer', kolab: 'test', layer: 'technical' }),   // the new mark
    JSON.stringify({ inbox: 'layer', kolab: 'test', layer: 'functional' }),  // the queue shrank
    JSON.stringify({ inbox: 'actor', kolab: 'test', actor: 'bob' }),         // the asker's answers
  ]));
  expect((await kolab.listQueries({ raisedBy: 'bob' })).map((x) => [x.state, x.answered_by])).toStrictEqual([['answered', 'alice']]);

  // Revising b1 addresses the mark; nothing else was touched.
  await kolab.commit(engineer, 'orders-pg', { deltas: [{ kind: 'override', element: 'b1', text: 'orders.status allows cancel from Open and Assigned; cancelling voids both invoices.' }] });
  expect(await marksOn(kolab, 'orders-pg')).toStrictEqual([]);
});

test('a note asks nothing: it waits in the owner\'s queue, and a reply marks nothing', async () => {
  const { kolab, product, engineer, draft } = await specAndBinding();
  await kolab.review(draft);
  const n = await kolab.raiseQuery(engineer, 'kj:orders#R13', 'Read "flagged" as a warning on the photo that does not block submission.',
    { kind: 'note', from: 'kj:orders-pg#b2' });
  expect((await kolab.listQueries({ layer: 'functional', state: 'open' })).map((x) => [x.id, x.kind])).toStrictEqual([[n, 'note']]);
  await kolab.answerQuery(product, n, 'Agreed.');
  expect(await marksOn(kolab, 'orders-pg')).toStrictEqual([]);
  expect((await kolab.listQueries({ raisedBy: 'bob' }))[0].answer).toBe('Agreed.');
});

test('from must name the asker\'s own layer, and must resolve', async () => {
  const { kolab, engineer } = await specAndBinding();
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R8', 'q', { from: 'kj:orders#R13' }))).toMatch(/own layer/);
  expect(await rejection(kolab.raiseQuery(engineer, 'kj:orders#R8', 'q', { from: 'kj:orders-pg@1#nope' }))).toMatch(/does not resolve/);
});

test('an answer to an element the binding has since removed still reaches the asker, without a mark', async () => {
  const { kolab, product, engineer, draft } = await specAndBinding();
  await kolab.review(draft);
  const q = await kolab.raiseQuery(engineer, 'kj:orders#R8', 'Who can cancel?', { from: 'kj:orders-pg#b1' });
  await kolab.commit(engineer, 'orders-pg', { deltas: [{ kind: 'remove', element: 'b1' }] });
  await kolab.answerQuery(product, q, 'Office staff.');
  expect(await marksOn(kolab, 'orders-pg')).toStrictEqual([]);
  expect((await kolab.listQueries({ raisedBy: 'bob' }))[0].state).toBe('answered');
});

test('a database from the previous release is migrated on open', async () => {
  const store = await persistentStore();
  {
    let kolab = await Kolab.open(store);
    await people(kolab, 'alice', { layers: ['functional'] });
    await people(kolab, 'bob', { layers: ['technical'] });
    const product = await kolab.openSession('alice', 'product');
    await kolab.createNode(product, 'functional_spec', 'Orders', 'orders');
    await kolab.commit(product, 'orders', { elements: els({ R1: 'Orders can be cancelled.' }) });
    // Put the tables back the way 0.5 created them, before migrations were recorded, before
    // agents (0002), before version bases (0003), before rebase_failed (0004), before rulings
    // without case files (0005), before accounts and kolabs (0006), before the review flow (0007),
    // before node names per kolab (0008), before the outbox (0010), before hashed session
    // tokens (0011), before link removals and the cascade's indexes (0012), before rulings' dates
    // and the case-file verbs' columns (0013), before archiving (0014), before rebase jobs (0015),
    // before outside readers' questions (0016) before links and forks across kolabs (0017), before OAuth (0018), before invites (0019), before the consent token's and the tombstone sweep's indexes (0020 and 0021, which go with oauth_request), before Read-only sessions' marks and mark-raised questions (0022) and before questions about versions in review (0023),
    // newest first (0009 only dropped what 0007 added, so its undoing is in 0007's). The people and the spec stay, and
    // alice's session is stored by its token again, as 0.5 stored it, so 0011 hashing it in place
    // is what keeps it working. 0014's kj_access goes with 0006's below, since 0006 made it.
    const keyed = ['version', 'element', 'delta', 'edge', 'invalidation', 'invalidation_cause', 'query', 'case_file', 'position', 'ruling', 'precedent'];
    const newlyRls = ['node', 'invalidation', 'invalidation_cause', 'case_file', 'position', 'ruling', 'precedent'];
    await kolab.db.exec(`
      drop policy kolab_read on query;
      create policy kolab_read on query for select to kj_agent
        using ((kolab_id = (select kj_session_kolab())
                and (invalidation_id is null or (select kj_session_belongs())))
               or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
                   and invalidation_id is null
                   and exists (select 1 from version v where v.id = query.version_id and v.state = 'committed')));
      alter table query drop constraint query_state_check;
      alter table query add constraint query_state_check check (state in ('open','answered'));
      alter table query drop column asked_version_id;
      drop policy kolab_read on query;
      create policy kolab_read on query for select to kj_agent
        using (kolab_id = (select kj_session_kolab())
               or (kolab_id = any ((select kj_session_readable_kolabs())::text[])
                   and invalidation_id is null
                   and exists (select 1 from version v where v.id = query.version_id and v.state = 'committed')));
      ${['invalidation', 'invalidation_cause'].map((t) => `drop policy kolab_read on ${t}; create policy kolab_read on ${t} for select to kj_agent using (kolab_id = (select kj_session_kolab()));`).join('\n')}
      drop table kolab_invite;
      alter table session drop column grant_id, drop column token_key, drop column expires_at;
      drop table oauth_refresh_token, oauth_code, oauth_grant, oauth_request, oauth_client, identity;
      drop function kj_identity_of_person(), kj_session_id();
      drop function kj_agent_cap(text, text);
      alter table actor drop column created_at;
      drop policy edge_target on edge;
      drop policy version_parent on version;
      drop policy delta_base on delta;
      drop function kj_session_may_fork(text, text, text), kj_session_may_base(text, text), kj_session_reads_version(text);
      drop trigger kolab_of_target on link_removal;
      drop function kj_link_removal_target_kolab();
      ${['edge', 'version', 'delta', 'invalidation'].map((t) => `drop trigger kolab_ref_check on ${t};`).join('\n')}
      drop trigger kolab_of_target on edge;
      drop function kj_kolab_ref_check(), kj_edge_target_kolab();
      alter table link_removal drop column target_kolab_id;
      alter table edge drop column target_kolab_id, drop column held_by;
      alter table version drop column parent_held_by;
      drop index version_parent;
      drop trigger session_openable on session;
      drop function kj_session_openable();
      ${['node', ...keyed, 'review_request', 'link_removal'].map((t) => `drop trigger kolab_writable_insert on ${t}; drop trigger kolab_writable_update on ${t}; drop trigger kolab_writable_delete on ${t};`).join('\n')}
      drop trigger kolab_writable_insert on kolab_grant; drop trigger kolab_writable_update on kolab_grant;
      drop function kj_kolab_writable(), kj_migrating();
      drop table archive_event;
      drop function kj_archive_event_fixed();
      drop index account_id_lower, actor_id_lower;
      alter table actor drop constraint actor_archived_is_agent, drop column archived_at;
      alter table kolab drop column archived_at;
      alter table account drop column archived_at;
      drop trigger ruling_by_person on ruling;
      drop function kj_ruling_by_person();
      drop trigger position_on_open_case on position;
      drop function kj_position_on_open_case();
      ${['ruling', 'position', 'case_file'].map((t) => `drop trigger case_fixed on ${t}; drop trigger case_kept on ${t};`).join('\n')}
      drop function kj_case_fixed();
      ${['ruling', 'position', 'case_file'].map((t) => `drop policy kolab_read on ${t}; create policy kolab_read on ${t} for select to kj_agent using (kolab_id = (select kj_session_kolab()));`).join('\n')}
      drop function kj_session_belongs();
      drop index case_file_kolab, position_case_file, ruling_kolab, one_position_per_actor, one_position_per_side, one_ruling_per_case_file;
      alter table position drop column created_at, drop column seeks;
      alter table case_file drop column question, drop column opened_by, drop column opened_at, drop column superseded_by;
      alter table ruling drop constraint ruling_id_kolab_key, drop column ruled_at, drop column effect;
      alter table case_file drop constraint case_file_state_check;
      alter table case_file add constraint case_file_state_check check (state in ('open','ruled'));
      update invalidation set reason = 'changed' where reason = 'ruled';
      alter table invalidation drop constraint invalidation_reason_check;
      alter table invalidation add constraint invalidation_reason_check check (reason in
        ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
         'upstream_dirty','review_failed','rebase_failed','role_boundary','query_answered'));
      drop table link_removal;
      drop function kj_link_removal_kolab();
      drop policy agent_draft on edge; drop policy kolab_delete on edge; revoke delete on edge from kj_agent;
      drop index edge_target_version, edge_source_version, invalidation_open_edge, invalidation_open_version, invalidation_cause_cause;
      alter table session drop constraint session_id_is_key;
      update session set id = '${product}' where id = '${sessionKey(product)}';
      drop table outbox;
      drop function kj_outbox_kolab();
      ${['node', 'version', 'element', 'query'].map((t) => `drop policy kolab_read on ${t}; create policy kolab_read on ${t} for select to kj_agent using (kolab_id = (select kj_session_kolab()));`).join('\n')}
      drop function kj_session_readable_kolabs();
      drop trigger node_name_fixed on node;
      drop function kj_node_name_fixed();
      alter table node drop column name cascade;
      drop table review_request;
      drop function kj_review_request_kolab();
      alter table version drop column resolves, drop column folded_from;
      alter table version drop constraint version_state_check;
      alter table version add constraint version_state_check check (state in ('drafted','committed','rejected'));
      ${['node', ...keyed].map((t) => `drop policy kolab_read on ${t};`).join('\n')}
      ${['version', 'element', 'delta', 'edge', 'query'].map((t) => `drop policy kolab_write on ${t}; create policy read_all on ${t} for select using (true);`).join('\n')}
      ${newlyRls.map((t) => `drop policy system_all on ${t}; alter table ${t} disable row level security;`).join('\n')}
      ${keyed.filter((t) => t !== 'precedent').map((t) => `drop trigger kolab_of_parent on ${t};`).join('\n')}
      drop function kj_kolab_of_parent();
      drop function kj_committed_version_of(text, text) cascade;   -- version's agent_layer, put back as 0003 had it
      create policy agent_layer on version for insert to kj_agent
        with check (state = 'drafted' and layer = kj_session_layer()
                    and layer = (select n.layer from node n where n.id = node_id)
                    and actor_id = kj_session_actor() and active_role = kj_session_role()
                    and (base_version_id is null
                         or exists (select 1 from version b where b.id = version.base_version_id
                                     and b.node_id = version.node_id and b.state = 'committed')));
      drop policy agent_layer on edge;
      create policy agent_layer on edge for insert to kj_agent
        with check (exists (select 1 from version v where v.id = source_version_id and v.layer = kj_session_layer()));
      create or replace function kj_session_layer() returns text
      language sql stable security definer as $$
        select case s.active_role when 'product' then 'functional' when 'engineer' then 'technical' end
        from session s
        where s.id = current_setting('kj.session', true) and s.ended_at is null
      $$;
      grant execute on function kj_session_layer(), kj_session_actor(), kj_session_role() to public;
      grant select on session, actor to kj_agent;
      drop function kj_session_kolab(), kj_access(text, text), kj_person_access(text, text), kj_level_rank(text);
      drop function kj_kolab_archived(text), kj_actor_archived(text);
      ${['session', 'node', ...keyed].map((t) => `alter table ${t} drop column kolab_id cascade;`).join('\n')}
      drop function kj_kolab_fixed();
      alter table precedent add unique (base_fingerprint, parent_fingerprint, child_fingerprint);
      alter table actor drop constraint actor_person_is_user, drop column account_kind, drop constraint actor_owner_is_account;
      alter table actor add column owner_kind text generated always as (case when owner_id is not null then 'person' end) stored,
                        add constraint actor_owner_is_person foreign key (owner_id, owner_kind) references actor(id, kind);
      drop table kolab_grant, kolab, team_member, team, org_member, account;
      drop table kj_migration;
      drop policy agent_layer on version;
      create policy agent_layer on version for insert to kj_agent
        with check (state = 'drafted' and layer = kj_session_layer()
                    and layer = (select n.layer from node n where n.id = node_id));
      alter table version drop column base_version_id;
      drop policy agent_layer on element;
      create policy agent_layer on element for insert to kj_agent
        with check (exists (select 1 from version v where v.id = version_id
                             and v.state = 'drafted' and v.layer = kj_session_layer()));
      drop policy agent_layer on delta;
      create policy agent_layer on delta for insert to kj_agent
        with check (exists (select 1 from version v where v.id = version_id
                             and v.state = 'drafted' and v.layer = kj_session_layer()));
      drop policy agent_layer on query;
      create policy agent_layer on query for insert to kj_agent
        with check (exists (select 1 from version v where v.id = version_id and v.layer = kj_session_layer()));
      drop function kj_session_actor(), kj_session_role();
      drop trigger actor_frozen on actor;
      drop function kj_actor_frozen();
      alter table actor drop constraint actor_id_check;
      drop index actor_owner;
      alter table actor drop constraint actor_owner_is_person, drop column owner_kind,
                        drop constraint actor_id_kind_key, drop column owner_id, drop column kind;
      alter table query drop constraint query_kind_check;
      alter table query drop column selector, drop column kind, drop column from_version_id,
                        drop column from_element_id, drop column answered_by, drop column created_at;
      alter table invalidation drop constraint invalidation_reason_check;
      alter table invalidation add constraint invalidation_reason_check check (reason in
        ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
         'upstream_dirty','review_failed','role_boundary'));
      alter table position drop column verdict;
      alter table ruling drop column replaces, drop column element_id, drop column version_id;
      alter table ruling alter column case_file_id set not null, alter column verdict set not null;`);
    await kolab.close();

    kolab = await Kolab.open(store);
    // 0006 gave both of them Write on both layers of the kolab `kolab`; with alice back to the
    // functional one, bob is alone on his and commits without review (W1.6).
    await kolab.grant('kolab', 'alice', 'write', { layers: ['functional'] });
    // 0008: the existing node keeps its id, now also its name in the kolab 0006 put it in.
    expect(await kolab.node('orders')).toMatchObject({ id: 'orders', name: 'orders', kolab_id: 'kolab' });
    const engineer = await kolab.openSession('bob', 'engineer');
    await kolab.createNode(engineer, 'technical_binding', 'B', 'b');
    await kolab.commit(engineer, 'b', { elements: els({ b1: 'Cancel endpoint.' }) });
    const q = await kolab.raiseQuery(engineer, 'kj:orders#R1~q({"exact":"cancelled"})', 'By whom?', { from: 'kj:b#b1' });
    await kolab.answerQuery(product, q, 'Office staff.');
    expect((await marksOn(kolab, 'b')).map((m) => m.reason)).toStrictEqual(['query_answered']);
    await kolab.close();
    // Opening again is a no-op.
    await (await Kolab.open(store)).close();
  }
});

// ---- over MCP --------------------------------------------------------------------

test('over MCP: questions sit beside the spec element, and answers are pushed to the asker', async () => {
  const server = await startServer({ adminToken: 'admin', ...(await testStore()) });
  closeAtEnd(server);
  const admin = await connect(server.url, 'admin');
  closeAtEnd(admin);
  const agent = async (actor: string, role: 'product' | 'engineer') => {
    await call(admin, 'admin_add_actor', { id: actor });
    await call(admin, 'admin_add_organization', { id: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_add_kolab', { name: 'test', owner: 'test-org' }).catch(() => undefined);
  await call(admin, 'admin_grant', { kolab: 'test', to: actor, level: 'write', layers: [role === 'product' ? 'functional' : 'technical'] });   // alone on its layer: no review (W1.6)
    const { token } = await call(admin, 'admin_open_session', { actor, role }) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return c;
  };
  const pm = await agent('pm', 'product');
  const eng = await agent('eng', 'engineer');

  expect((await call(eng, 'whoami') as { subscribe: string[] }).subscribe).toStrictEqual(['konjir://inbox/test/technical', 'konjir://answers/test/eng']);

  // Each side watches its own inboxes.
  const pushed: { who: string; uri: string; body: { queries?: { kind: string; answer?: string | null }[]; marks?: unknown[] } }[] = [];
  const arrived = (n: number) => new Promise<void>((resolve) => {
    const t = setInterval(() => { if (pushed.length >= n) { clearInterval(t); resolve(); } }, 10);
  });
  const wPm = await watch(pm, (uri, body) => { pushed.push({ who: 'pm', uri, body: body as never }); });
  const wEng = await watch(eng, (uri, body) => { pushed.push({ who: 'eng', uri, body: body as never }); });
  closeAtEnd(wPm.subscription, wEng.subscription);

  await call(pm, 'create_node', { kind: 'functional_spec', title: 'Orders', id: 'orders' });
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 1 });
  await call(eng, 'create_node', { kind: 'technical_binding', title: 'Orders on Postgres', id: 'orders-pg' });
  await call(eng, 'draft', { node: 'orders-pg', elements: [{ id: 'b1', text: 'Cancel allowed from Open.' }] });

  // The engineer asks; product is told.
  pushed.length = 0;
  const { query } = await call(eng, 'ask', { address: 'kj:orders#R8', question: 'From which statuses?', from: 'kj:orders-pg@1#b1' }) as { query: string };
  await call(eng, 'annotate', { address: 'kj:orders#R8', note: 'Assuming office staff means the Office role.' });
  await arrived(2);
  expect(pushed.every((p) => p.who === 'pm' && p.uri === 'konjir://inbox/test/functional')).toBeTruthy();
  expect(pushed.at(-1)!.body.queries!.map((q) => q.kind)).toStrictEqual(['question', 'note']);

  // The spec moves on to v2; the question still shows beside R8.
  await call(pm, 'draft', { node: 'orders', elements: [{ id: 'R8', text: 'Office staff can cancel an order that is not yet completed.' }] });
  await call(pm, 'submit_for_review', { node: 'orders', version: 2 });
  const read = await call(pm, 'read_node', { node: 'orders' }) as { version: number; elements: { id: string; questions?: { id: string; on: string; kind: string; from: string | null }[] }[] };
  expect(read.version).toBe(2);
  expect(read.elements[0].questions!.map((q) => [q.id, q.kind, q.on, q.from])).toStrictEqual([
    [query, 'question', 'kj:orders@1#R8', 'kj:orders-pg@1#b1'],
    [read.elements[0].questions![1].id, 'note', 'kj:orders@1#R8', null],
  ]);

  // Product answers; the engineer hears it on both inboxes.
  pushed.length = 0;
  await call(pm, 'answer_query', { query, answer: 'Any status before Completed.' });
  await arrived(3);
  const engHeard = new Set(pushed.filter((p) => p.who === 'eng').map((p) => p.uri));
  expect(engHeard).toStrictEqual(new Set(['konjir://inbox/test/technical', 'konjir://answers/test/eng']));
  const answers = pushed.find((p) => p.uri === 'konjir://answers/test/eng')!.body.queries!;
  expect(answers.find((q) => q.kind === 'question')!.answer).toBe('Any status before Completed.');

  // Nobody reads someone else's answers.
  expect(await rejection(pm.readResource({ uri: 'konjir://answers/test/eng' }))).toMatch(/your own answers/);
});

test('over MCP: an engineer agent asks about a version in review, and konjir_submit_for_review says who can review, or that nobody can yet (D65)', async () => {
  const server = await startServer({ adminToken: 'admin', ...(await testStore()) });
  closeAtEnd(server);
  const admin = await connect(server.url, 'admin');
  closeAtEnd(admin);
  // Pat, a product owner, works in an organization's kolab with an agent of Pat's that holds Write
  // on both layers and is signed in as engineer: the one other writer on the functional layer.
  await call(admin, 'admin_add_organization', { id: 'shop' });
  await call(admin, 'admin_add_kolab', { name: 'checkout', owner: 'shop' });
  await call(admin, 'admin_add_actor', { id: 'pat' });
  await call(admin, 'admin_add_actor', { id: 'pat-eng', owner: 'pat' });
  for (const to of ['pat', 'pat-eng']) await call(admin, 'admin_grant', { kolab: 'checkout', to, level: 'write' });
  const open = async (actor: string, role: 'product' | 'engineer') => {
    const { token } = await call(admin, 'admin_open_session', { actor, role }) as { token: string };
    const c = await connect(server.url, token);
    closeAtEnd(c);
    return c;
  };
  const pat = await open('pat', 'product');
  const eng = await open('pat-eng', 'engineer');

  await call(pat, 'create_node', { kind: 'functional_spec', title: 'Checkout', id: 'checkout' });
  await call(pat, 'draft', { node: 'checkout', elements: [{ id: 'R1', text: 'Checkout completes in 30 seconds.' }, { id: 'R2', text: 'A failed payment can be retried.' }] });
  const submitted = await call(pat, 'submit_for_review', { node: 'checkout', version: 1 }) as { in_review: string; reviewers: string[]; review: string; next: string };
  expect(submitted).toMatchObject({ ok: false, in_review: 'kj:checkout@1', reviewers: [] });
  expect(submitted.review).toContain(nobodyCanReview('functional'));
  expect(submitted.next).toBe(`In review. ${nobodyCanReview('functional')} The verdict comes back in your answers (konjir_list_reviews).`);
  // The engineer agent is not asked to review a layer its role can't write.
  expect(await call(eng, 'list_reviews', {})).toMatchObject({ for_you: [] });

  // It asks about R2 of the version in review; without @version it is told which address to use.
  expect(await rejection(call(eng, 'ask', { address: 'kj:checkout#R2', question: 'How many retries?' }))).toMatch(/checkout@1 is in review: ask about kj:checkout@1#R2/);
  const { query } = await call(eng, 'ask', { address: 'kj:checkout@1#R2', question: 'How many retries?' }) as { query: string };
  expect(await call(pat, 'answer_query', { query, answer: 'Three times.' })).toStrictEqual({ answered: query });

  // A second product writer: resubmitted, the version names them.
  await call(admin, 'admin_add_actor', { id: 'quinn' });
  await call(admin, 'admin_grant', { kolab: 'checkout', to: 'quinn', level: 'write', layers: ['functional'] });
  expect(await call(pat, 'submit_for_review', { node: 'checkout', version: 1 })).toMatchObject({
    in_review: 'kj:checkout@1', reviewers: ['quinn'], next: expect.stringMatching(/^In review: quinn has a review request in their inbox/),
  });
});
