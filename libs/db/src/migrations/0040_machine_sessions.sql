-- Migration 0040: a person holds a session on each machine (W6.1; D103, ENF4, DEL7).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Until now each actor held at most one open session (one_open_session_per_actor, 0001), so a
-- person signing in anywhere ended their session everywhere else (D41, D56). D103 replaces that for
-- people: a sign-in ends only the session it replaces, the same actor's from the same machine. An
-- agent still holds one open session, whichever client it signs in through, and each job's agent
-- its own.
--
-- A session's machine is `machine_key`, what Kolab compares a new sign-in against:
--   agent             every session of an agent, so an agent still holds one (the trigger below)
--   client:<id>       a person's sign-in through an OAuth client: each konjir install (the CLI and
--                     the channel bridge beside it share its one registration), and each harness
--                     entry, registers a client of its own and keeps it
--   web:<key>         a person's sign-in to Kolab's web page, by browser: the sha256 of a random
--                     secret the browser keeps in a cookie of its own (konjir_browser)
--   token             a person's hand-issued session (admin_open_session): one at a time, as
--                     before, which an admin ends before opening another; so a person's sessions
--                     an admin opens still hold one role at a time
-- `place` is what the person is shown of where it is, such as a browser's name and system; none
-- for the others, which their client's name says.
--
-- `last_used_at` is when the session last renewed its sign-in: each refresh of its access token,
-- every 15 minutes while it works, and nothing on any other call. Null until then: it was last
-- used when it opened.
--
-- Open sessions are given their machine here, from what they already record; ended ones keep none.
-- Each actor held one open session, so the new unique index can't find two on one machine: it can
-- neither refuse a database nor change who is signed in, and needs no preflight.

alter table session
  add column machine_key  text check (machine_key is null or (length(machine_key) between 5 and 200)),
  add column place        text check (place is null or length(place) between 1 and 100),
  add column last_used_at timestamptz;

update session s set machine_key = case
    when a.kind = 'agent' then 'agent'
    when s.grant_id is null then 'token'
    else 'client:' || (select g.client_id from oauth_grant g where g.id = s.grant_id)
  end
  from actor a where a.id = s.actor_id and s.ended_at is null;

-- Every open session has its machine; an agent's is always `agent`, and a person's never is.
alter table session add constraint session_machine_open check (ended_at is not null or machine_key is not null);

create function kj_session_machine() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare k text;
begin
  if kj_migrating() then return new; end if;
  select kind into k from actor where id = new.actor_id;
  if k = 'agent' and new.machine_key is distinct from 'agent' then
    raise exception 'an agent holds one session, whatever it signs in through: its machine_key is agent' using errcode = 'check_violation';
  end if;
  if k = 'person' and new.machine_key = 'agent' then
    raise exception 'a person''s session is on a machine of its own, never agent' using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_session_machine() from public;
create trigger session_machine before insert or update of machine_key, actor_id on session
  for each row execute function kj_session_machine();

-- One open session per actor and machine: for an agent, one in all.
drop index one_open_session_per_actor;
create unique index one_open_session_per_machine on session(actor_id, machine_key) where ended_at is null;
