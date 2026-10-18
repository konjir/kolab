-- Migration 0018: sign-in with GitHub, and Kolab as an OAuth 2.1 authorization server (D55; RUN3, ENF4, ENF5, API8).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A person signs up and signs in with an identity provider (GitHub first), so their first session
-- needs no admin. An MCP client, or the web interface, gets a short-lived access token and a
-- rotating refresh token through Kolab's own authorization server, in place of a hand-issued
-- session token that never expires.
--
-- An access token is a session token: the session it opens is the same one-actor, one-kolab,
-- one-role session as ever (ENF4, ENF5), so every check, row-level security included, applies to
-- it unchanged. What is new is that such a session belongs to a grant (what a person authorized a
-- client to do), and that its token rotates: the session keeps its id, while `token_key`, the
-- sha256 of its current access token, and `expires_at`, when that token expires, change at each
-- refresh. A hand-issued session has neither: its id is its token's key, as 0011 made it, and it
-- never expires.
--
-- Nothing here stores a token, a code or a secret: every one is held as its sha256, base64url
-- (P1). None of these tables is kolab data, and only Kolab's own login reads them: kj_agent and
-- kj_system are granted nothing on them.

-- ---------------------------------------------------------------------------
-- Identities: who a person is at an identity provider
-- ---------------------------------------------------------------------------

-- A person's identity at a provider, by the provider's own stable id for them (GitHub's numeric
-- user id), never by a login name, which can change hands. `login` is what the provider calls
-- them now, kept for display only. One identity per provider per person.
create table identity (
  provider     text not null check (provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  subject      text not null check (subject ~ '^[A-Za-z0-9._@|:-]{1,200}$'),
  actor_id     text not null references actor(id),
  login        text not null check (length(login) between 1 and 200),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (provider, subject)
);
create unique index identity_one_per_provider on identity(actor_id, provider);

-- Only a person has an identity: an agent is never signed in as, it is authorized by its owner.
create function kj_identity_of_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from public.actor a where a.id = new.actor_id and a.kind = 'person') then
    raise exception 'only a person has an identity; % is not one', new.actor_id using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_identity_of_person() from public;
create trigger identity_of_person before insert or update of actor_id on identity
  for each row execute function kj_identity_of_person();

-- ---------------------------------------------------------------------------
-- The authorization server: clients, pending authorizations, codes, grants and refresh tokens
-- ---------------------------------------------------------------------------

-- A client registered dynamically (RFC 7591): a public client (no secret), with the redirect URIs
-- it may receive codes at, matched exactly. The web interface is Kolab's own client and isn't here.
-- `last_used_at` is when it last started an authorization or used the token endpoint: a client
-- never used is deleted a day after it registered, and one unused for 30 days with no live grant
-- is deleted then, so anyone registering clients can't fill the table.
create table oauth_client (
  id            text primary key check (id ~ '^kjcl_[A-Za-z0-9_-]{22,64}$'),
  name          text not null check (length(name) between 1 and 200),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 10),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

-- An authorization in progress, from GET /oauth/authorize until it is consented to and its code
-- issued, or it expires. `id` is the key of the value in the browser's binding cookie, and
-- `state_key` the key of the state sent to the identity provider, so the callback must come back
-- to the browser that started it, with the state it was sent. Once the provider has said who the
-- person is, `actor_id` is set, and `csrf_key` is the key of the consent form's token. A consent
-- claims the request (`claimed_at`) before it makes anything, so two submissions of one form can't
-- both make an agent or a kolab; one that fails releases it, so the page can be corrected.
create table oauth_request (
  id             text primary key check (id ~ '^[A-Za-z0-9_-]{43}$'),
  state_key      text not null unique check (state_key ~ '^[A-Za-z0-9_-]{43}$'),
  provider       text not null,
  client_id      text not null,
  redirect_uri   text not null,
  client_state   text check (length(client_state) <= 1000),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  scope          text check (length(scope) <= 1000),
  resource       text check (length(resource) <= 1000),
  actor_id       text references actor(id),
  csrf_key       text check (csrf_key ~ '^[A-Za-z0-9_-]{43}$'),
  claimed_at     timestamptz,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);
create index oauth_request_expires on oauth_request(expires_at);

-- What a person authorized one client to do: act as them, or as an agent of theirs (D30), until
-- it is revoked or no refresh renews it before `expires_at`. Its session, the one open session of
-- that actor that names it, carries the kolab and the role. `person_id` is who authorized it.
create table oauth_grant (
  id         text primary key check (id ~ '^[A-Za-z0-9_-]{22,43}$'),
  client_id  text not null,
  actor_id   text not null references actor(id),
  person_id  text not null references actor(id),
  scope      text not null,
  resource   text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index oauth_grant_actor on oauth_grant(actor_id);

-- An authorization code (RFC 6749 §4.1), one use, bound to its client, redirect URI and PKCE
-- challenge (S256 only). It says what was consented to: the actor, kolab and role. Once used it
-- names the grant it opened, which a second use of the code revokes (RFC 6749 §4.1.2).
create table oauth_code (
  key            text primary key check (key ~ '^[A-Za-z0-9_-]{43}$'),
  client_id      text not null,
  redirect_uri   text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  person_id      text not null references actor(id),
  actor_id       text not null references actor(id),
  kolab          text not null references kolab(id),
  role           text not null check (role in ('product', 'engineer')),
  scope          text not null,
  resource       text,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  grant_id       text references oauth_grant(id)
);
create index oauth_code_expires on oauth_code(expires_at);

-- A refresh token, by its key. Each refresh uses one and issues the next (rotation); one presented
-- again after use is a replay, and revokes its grant.
create table oauth_refresh_token (
  key        text primary key check (key ~ '^[A-Za-z0-9_-]{43}$'),
  grant_id   text not null references oauth_grant(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);
create index oauth_refresh_token_grant on oauth_refresh_token(grant_id);

revoke all on identity, oauth_client, oauth_request, oauth_grant, oauth_code, oauth_refresh_token from public;
revoke all on identity, oauth_client, oauth_request, oauth_grant, oauth_code, oauth_refresh_token from kj_agent, kj_system;

-- ---------------------------------------------------------------------------
-- A session opened by a grant: a rotating access token that expires
-- ---------------------------------------------------------------------------

alter table session
  add column grant_id   text references oauth_grant(id),
  add column token_key  text,
  add column expires_at timestamptz;
alter table session add constraint session_token_key_is_key check (token_key ~ '^[A-Za-z0-9_-]{43}$');
-- A grant's session has all three; a hand-issued one has none.
alter table session add constraint session_grant_token check (
  (grant_id is null) = (token_key is null) and (token_key is null) = (expires_at is null));
create unique index session_token_key on session(token_key) where token_key is not null;
create index session_grant on session(grant_id) where grant_id is not null;

-- The session the current transaction acts in: the open session whose current token's key is
-- kj.session. A grant's session is found by its token's key, and only until that token expires;
-- a hand-issued one by its id, which is its token's key (0011). So a rotated or expired access
-- token reaches nothing, here as in Kolab.
create function kj_session_id() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select s.id from public.session s
   where s.ended_at is null
     and (s.token_key = current_setting('kj.session', true)
          or (s.token_key is null and s.id = current_setting('kj.session', true)))
     and (s.expires_at is null or s.expires_at > now())
$$;
revoke execute on function kj_session_id() from public;

-- The session helpers, as 0002, 0006, 0008 and 0013 left them, now finding the session through
-- kj_session_id, each once per statement. Each keeps its grants; each searches pg_temp last.
create or replace function kj_session_actor() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select s.actor_id from public.session s where s.id = (select public.kj_session_id())
$$;
create or replace function kj_session_role() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select s.active_role from public.session s where s.id = (select public.kj_session_id())
$$;
create or replace function kj_session_kolab() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select s.kolab_id from public.session s
   where s.id = (select public.kj_session_id())
     and (select a.rank from public.kj_access(s.actor_id, s.kolab_id) a) >= 1
$$;
create or replace function kj_session_layer() returns text
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select l.layer
    from public.session s
   cross join lateral (select case s.active_role when 'product' then 'functional' when 'engineer' then 'technical' end as layer) l
   cross join lateral public.kj_access(s.actor_id, s.kolab_id) a
   where s.id = (select public.kj_session_id())
     and a.rank >= 3
     and case l.layer when 'functional' then a.functional else a.technical end
$$;
create or replace function kj_session_readable_kolabs() returns text[]
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with recursive me as (
    select a.id, a.kind from public.session s join public.actor a on a.id = s.actor_id
     where s.id = (select public.kj_session_id())
  ), teams(id) as (
    select tm.team_id from public.team_member tm join me on tm.user_id = me.id
    union
    select t.parent_id from public.team t join teams on t.id = teams.id where t.parent_id is not null
  ), candidates(id) as (
    select g.kolab_id from public.kolab_grant g join me on g.agent_id = me.id or g.user_id = me.id
    union select g.kolab_id from public.kolab_grant g where g.team_id in (select id from teams)
    union select k.id from public.kolab k join me on me.kind = 'person' and k.owner_id = me.id
    union select k.id from public.kolab k join public.org_member m on m.org_id = k.owner_id
                                          join me on me.kind = 'person' and m.user_id = me.id
    union select k.id from public.kolab k join me on me.kind = 'person' and k.visibility = 'public'
  )
  select coalesce(array_agg(c.id order by c.id), '{}') from candidates c, me
   where (select a.rank from public.kj_access(me.id, c.id) a) >= 1
$$;
create or replace function kj_session_belongs() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select a.functional or a.technical
                     from public.session s cross join lateral public.kj_access(s.actor_id, s.kolab_id) a
                    where s.id = (select public.kj_session_id())), false)
$$;
