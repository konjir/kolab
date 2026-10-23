-- Migration 0026: admins are people, not a token (W2.22; D69).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Specific people, signed in with GitHub (D55), are Konjir's admins. Each is a row of
-- konjir_admin, with who made them one and when. Only a person can be one, never an agent (D30,
-- D56). An admin runs the admin verbs from their own sign-in, once they have raised it for a short
-- while (session.admin_until), and each admin write records them as who made it (W2.20, D70). The
-- static admin token stays only as a break-glass, and each use of it is recorded too.
--
-- Like audit_event, it is access metadata: only Kolab's own login reads or writes it, and kj_agent
-- and kj_system are granted nothing.
create table konjir_admin (
  actor_id   text primary key references actor(id),
  granted_by text not null constraint konjir_admin_granted_by_check check (btrim(granted_by) <> ''),
  granted_at timestamptz not null default clock_timestamp()
);
alter table konjir_admin enable row level security;
revoke all on konjir_admin from public;
revoke all on konjir_admin from kj_agent, kj_system;

-- Only a person is an admin. An actor's kind never changes once it is added, so checking as the
-- row is written is enough.
create function kj_admin_is_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from public.actor a where a.id = new.actor_id and a.kind = 'person') then
    raise exception 'konjir_admin: % is not a person; only a person can be a Konjir admin, never an agent (D69, D30)', new.actor_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_admin_is_person() from public;
create trigger konjir_admin_person before insert or update on konjir_admin for each row execute function kj_admin_is_person();

-- The audit log's new actions:
--   admin.granted      a person made a Konjir admin: subject is the person
--   admin.revoked      a person's admin removed: subject is the person
--   admin.elevated     an admin raised their own session to run admin verbs: subject is the person;
--                      detail holds the session's key and until when
--   admin.lowered      an admin ended that before it lapsed
--   break_glass.used   the static admin token ran an admin verb: subject is the verb
alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used'));   -- AUDIT_ACTIONS in @konjir/types

-- Making or removing an admin leaves no row of its own once removed, so, as for a grant (0024),
-- its audit_event row is the record and the database requires it: as the transaction commits, each
-- row it inserted or deleted in konjir_admin must have an audit_event row added by the same
-- transaction for the same person, admin.granted or admin.revoked. Deferred, and the migration
-- runner is exempt, as kj_access_audited.
create function kj_admin_audited() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  r record;
  act text;
begin
  if kj_migrating() then return null; end if;
  if tg_op = 'DELETE' then r := old; act := 'admin.revoked'; else r := new; act := 'admin.granted'; end if;
  if not exists (select 1 from public.audit_event a where a.tx = pg_current_xact_id() and a.subject = r.actor_id and a.action = act) then
    raise exception 'konjir_admin: making or removing an admin (%) must be recorded in the audit log, with who did it (W2.22)', r.actor_id
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;
revoke execute on function kj_admin_audited() from public;
create constraint trigger konjir_admin_audited after insert or update or delete on konjir_admin deferrable initially deferred for each row
  execute function kj_admin_audited();

-- Until when the session's person may run admin verbs, once they raise it (konjir_admin_elevate):
-- null when they haven't, or lowered it. Kolab honours it only while its person is still an admin,
-- on a session they signed in to with the identity provider (D55), checked on every request.
alter table session add column admin_until timestamptz;

-- A raise is asked for over MCP or the CLI, and completed only in a browser (W2.22, Lee's ruling of
-- 2026-10-23): konjir_admin_elevate records the request here and answers with a link, and the raise
-- applies to the session only once its person opens the link in a browser, signs in with the
-- identity provider as themselves (GitHub's account picker: GitHub has no forced re-authentication,
-- so it is not a password or 2FA check) and confirms on Kolab's own page. No MCP call completes one.
-- `id` is the sha256 of the link's secret (P1). A request lasts as long as a sign-in and is used
-- once: completed, or cancelled (declined on its page, cancelled at the identity provider, or
-- reached by someone else's sign-in), after which it never completes.
create table admin_raise (
  id           text primary key check (id ~ '^[A-Za-z0-9_-]{43}$'),
  session_id   text not null references session(id),
  actor_id     text not null references actor(id),
  created_at   timestamptz not null default clock_timestamp(),
  expires_at   timestamptz not null,
  completed_at timestamptz,
  cancelled_at timestamptz,
  constraint admin_raise_used_once check (completed_at is null or cancelled_at is null)
);
create index admin_raise_expires on admin_raise(expires_at);
alter table admin_raise enable row level security;
revoke all on admin_raise from public;
revoke all on admin_raise from kj_agent, kj_system;

-- The browser step is a sign-in of Kolab's own (`client_id` konjir-raise), through the same
-- authorization in progress as every other: its binding cookie, its state at the identity provider
-- and its form token (D55, D57). `raise_id` names the request it completes; it goes with it.
alter table oauth_request add column raise_id text references admin_raise(id) on delete cascade;

-- Hand-issued session tokens (konjir_admin_open_session, deploy/konjir-ops.sh connect) expire
-- (W2.22, Lee's ruling of 2026-10-23): 30 days after they are issued, by default. One issued before
-- this migration had no expiry; it gets one 30 days from now, as this release is deployed, and is
-- then refused like an ended one (kj_session_id and Kolab both read session.expires_at). 0018 tied
-- an expiry to a grant's session alone; from here every open session has one, and a hand-issued
-- session that ended before this migration keeps none.
alter table session drop constraint session_grant_token;
update session set expires_at = now() + interval '30 days'
 where grant_id is null and ended_at is null and expires_at is null;
alter table session add constraint session_grant_token check (
  (grant_id is null) = (token_key is null)
  and (grant_id is null or expires_at is not null)
  and (expires_at is not null or ended_at is not null));
