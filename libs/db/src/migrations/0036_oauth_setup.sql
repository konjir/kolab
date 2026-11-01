-- Migration 0036: a setup, `konjir connect`'s one sign-in (Lee's instruction of 2026-11-01).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A setup is an authorization whose scope names a kolab and the agents to work there
-- (`konjir kolab:<k> setup:<label>:<role> …`). The person allows it on one page: Kolab makes the
-- kolab if it is new and the agents that are, grants each in the kolab, and issues this row's code.
-- The code is exchanged, once, with PKCE, by the client it was issued to, for a setup token: not a
-- session (no /mcp call works with it), only the right to have Kolab issue each named agent its own
-- grant and refresh token, once, to that same client (POST /oauth/setup). Kolab stores only the
-- code's and the token's keys (P1), as it does every other secret.
--
-- A new table, empty: it neither refuses a database nor changes what is in one.

create table oauth_setup (
  id               text primary key check (id ~ '^[A-Za-z0-9_-]{43}$'),   -- the code's key
  client_id        text not null references oauth_client(id) on delete cascade,
  redirect_uri     text not null,
  code_challenge   text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource         text,
  person_id        text not null references actor(id),
  -- No reference to kolab: the row is made first, to count toward the rate, before a new kolab is.
  kolab            text not null,
  kolab_made       boolean not null,
  -- The agents the person allowed, in order: [{"label", "agent", "role", "made"}].
  agents           jsonb not null check (jsonb_typeof(agents) = 'array'),
  made_agents      integer not null check (made_agents >= 0),
  created_at       timestamptz not null default now(),
  code_expires_at  timestamptz not null,
  code_used_at     timestamptz,
  -- Who the code was exchanged for: the setup's person (W2.20).
  exchanged_by     text references actor(id),
  token_key        text unique check (token_key ~ '^[A-Za-z0-9_-]{43}$'),
  token_expires_at timestamptz,
  used_at          timestamptz,
  revoked_at       timestamptz,
  -- The grants the setup issued, so a replayed code revokes them.
  grants           text[] not null default '{}'
);
-- How many setups that made agents a person ran lately (the setup's rate).
create index oauth_setup_person on oauth_setup(person_id, created_at);

revoke all on oauth_setup from public;
revoke all on oauth_setup from kj_agent, kj_system;
