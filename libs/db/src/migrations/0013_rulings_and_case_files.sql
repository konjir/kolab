-- Migration 0013: rulings record their date, and case files, positions and rulings get the
-- columns and rules their verbs need (W2.14; DAT9, CASE1–CASE7, D16, D49, D50, D51).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A disagreement agents can't settle becomes a case file: what is disputed, about an element,
-- and two positions, one for each side: one seeks to keep the intent as written, the other to
-- change it (CASE1). A person with Write on the element's layer rules on it, sustaining exactly
-- one position and overruling the other (CASE2, D51), or rules directly with no case file (CASE3,
-- D16; 0005), which supersedes any case file still open on that element. Every ruling records its
-- author and date, and is served back as precedent in its kolab (CASE4, TEN13), to those who
-- belong to the kolab's work only (D49). A ruling either changes the intent or keeps it and asks
-- for another way (CASE6); one that changes it marks the element ruled on (D51).
--
-- Every row here is written by Kolab's verbs, as kj_system, after Kolab's checks: no agent writes
-- a case file, a position or a ruling directly (0006 gives kj_agent no insert on them).
--
-- No verb wrote these tables before this release, so the rows already there are the ones tests
-- and earlier migrations made by hand. Their dates, authors and sides were never recorded and
-- aren't guessed: the checks below bind new rows only (not valid), as 0002's actor_id_check does.

-- ---------------------------------------------------------------------------
-- Value lists (D40)
-- ---------------------------------------------------------------------------

-- A case file a direct ruling settled before it was ruled on is superseded.
alter table case_file drop constraint case_file_state_check;
alter table case_file add constraint case_file_state_check check (state in
  ('open','ruled','superseded'));                             -- CASE_FILE_STATES in @konjir/types

-- A ruling that changes the intent marks the element it rules on, with a question to its layer,
-- until a later version of it settles the mark (D51).
alter table invalidation drop constraint invalidation_reason_check;
alter table invalidation add constraint invalidation_reason_check check (reason in
  ('changed','fuzzy_reanchor','orphaned','override_stale','override_orphaned',
   'upstream_dirty','review_failed','rebase_failed','role_boundary','query_answered','ruled'));
                                                              -- MARK_REASONS in @konjir/types

-- ---------------------------------------------------------------------------
-- Rulings: the date (CASE4) and the effect (CASE6)
-- ---------------------------------------------------------------------------

-- Added with no default, so the rows already there keep no date rather than this migration's;
-- every row after it is dated as it is written.
alter table ruling add column ruled_at timestamptz;
alter table ruling alter column ruled_at set default clock_timestamp();
alter table ruling add constraint ruling_dated check (ruled_at is not null) not valid;

-- Whether the ruling changes the intent, or keeps it and asks for another way (CASE6).
alter table ruling add column effect text
  constraint ruling_effect_check check (effect in ('change_intent','keep_intent'));   -- RULING_EFFECTS in @konjir/types
alter table ruling add constraint ruling_has_effect check (effect is not null) not valid;

-- A case file can name the direct ruling that superseded it, in its own kolab.
alter table ruling add constraint ruling_id_kolab_key unique (id, kolab_id);

-- ---------------------------------------------------------------------------
-- Case files and positions: who, when, what is disputed, and which side (CASE1)
-- ---------------------------------------------------------------------------

alter table case_file add column question text;
alter table case_file add column opened_by text;
alter table case_file add column opened_at timestamptz;
alter table case_file alter column opened_at set default clock_timestamp();
alter table case_file add constraint case_file_opened check (question is not null and opened_by is not null and opened_at is not null) not valid;
alter table case_file add column superseded_by text,
  add constraint case_file_superseded_kolab_fkey foreign key (superseded_by, kolab_id) references ruling(id, kolab_id);
alter table case_file add constraint case_file_superseded check ((state = 'superseded') = (superseded_by is not null));

alter table position add column created_at timestamptz;
alter table position alter column created_at set default clock_timestamp();
alter table position add constraint position_dated check (created_at is not null) not valid;
-- The side a position takes: it seeks to keep the intent as written, or to change it. The two
-- positions of a case file take opposite sides, and a ruling's effect is the side it sustains.
alter table position add column seeks text
  constraint position_seeks_check check (seeks in ('change_intent','keep_intent'));    -- RULING_EFFECTS in @konjir/types
alter table position add constraint position_has_side check (seeks is not null) not valid;

-- One ruling per case file, one position per actor and one per side. The rows already there were
-- written by hand, so a duplicate among them stops the migration, naming it, rather than guess
-- which to keep.
do $$
declare dup text;
begin
  select string_agg(format('case file %s has rulings %s', case_file_id, ids), '; ') into dup
    from (select case_file_id, string_agg(id, ', ' order by id) as ids from ruling
           where case_file_id is not null group by case_file_id having count(*) > 1) d;
  if dup is not null then
    raise exception 'migration 0013: a case file is ruled on once, but %; remove all but one first', dup;
  end if;
  select string_agg(format('%s holds positions %s on case file %s', actor_id, ids, case_file_id), '; ') into dup
    from (select case_file_id, actor_id, string_agg(id, ', ' order by id) as ids from position
           group by case_file_id, actor_id having count(*) > 1) d;
  if dup is not null then
    raise exception 'migration 0013: an actor takes one position on a case file, but %; remove all but one first', dup;
  end if;
end
$$;
create unique index one_ruling_per_case_file on ruling(case_file_id) where case_file_id is not null;
create unique index one_position_per_actor on position(case_file_id, actor_id);
create unique index one_position_per_side on position(case_file_id, seeks) where seeks is not null;

-- What the read policies filter on, and how a case file finds its positions.
create index case_file_kolab on case_file(kolab_id);
create index position_case_file on position(case_file_id);
create index ruling_kolab on ruling(kolab_id);

-- ---------------------------------------------------------------------------
-- Reading: only those who belong to the kolab's work (D49)
-- ---------------------------------------------------------------------------

-- Whether the current session belongs to its kolab's work: its actor holds Write on a layer of it
-- (Write, Maintain or Admin), not Read alone. A reader such as anyone reading a public kolab sees
-- none of its case files, positions or rulings (D49), even in a session opened there.
create function kj_session_belongs() returns boolean
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select a.functional or a.technical
                     from public.session s cross join lateral public.kj_access(s.actor_id, s.kolab_id) a
                    where s.id = current_setting('kj.session', true) and s.ended_at is null), false)
$$;
revoke execute on function kj_session_belongs() from public;
grant execute on function kj_session_belongs() to kj_agent;

drop policy kolab_read on case_file;
drop policy kolab_read on position;
drop policy kolab_read on ruling;
create policy kolab_read on case_file for select to kj_agent using (kolab_id = (select kj_session_kolab()) and (select kj_session_belongs()));
create policy kolab_read on position  for select to kj_agent using (kolab_id = (select kj_session_kolab()) and (select kj_session_belongs()));
create policy kolab_read on ruling    for select to kj_agent using (kolab_id = (select kj_session_kolab()) and (select kj_session_belongs()));

-- ---------------------------------------------------------------------------
-- A ruling stands as given (stare decisis)
-- ---------------------------------------------------------------------------

-- Precedent is only precedent if it can't be rewritten or removed: for any role, a ruling never
-- changes and is never deleted; a later ruling says what it overrules (`replaces`) instead. A
-- position keeps its claim, evidence and side; its verdict is set once, by its case file's
-- ruling. A case file keeps its subject and question; it moves from open to ruled once, with its
-- ruling, or to superseded by a direct ruling. None of the three is ever deleted or truncated.
create function kj_case_fixed() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception '%: case files, positions and rulings are never removed: a ruling is precedent, and a later one says what it replaces', tg_table_name
      using errcode = 'check_violation';
  end if;
  if tg_table_name = 'ruling' then
    raise exception 'ruling %: a ruling never changes once given; give another that replaces it', old.id
      using errcode = 'check_violation';
  elsif tg_table_name = 'position' then
    if new.id is distinct from old.id or new.case_file_id is distinct from old.case_file_id
       or new.actor_id is distinct from old.actor_id or new.claim is distinct from old.claim
       or new.evidence is distinct from old.evidence or new.created_at is distinct from old.created_at
       or new.seeks is distinct from old.seeks
       or (old.verdict is not null and new.verdict is distinct from old.verdict) then
      raise exception 'position %: a position never changes once taken; only its ruling sets its verdict, once', old.id
        using errcode = 'check_violation';
    end if;
    if new.verdict is not null and old.verdict is null
       and not exists (select 1 from public.ruling r where r.case_file_id = new.case_file_id) then
      raise exception 'position %: only its case file''s ruling sets its verdict, and case file % has none', old.id, new.case_file_id
        using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'case_file' then
    if new.id is distinct from old.id or new.version_id is distinct from old.version_id
       or new.element_id is distinct from old.element_id or new.question is distinct from old.question
       or new.opened_by is distinct from old.opened_by or new.opened_at is distinct from old.opened_at
       or (old.state <> 'open' and (new.state is distinct from old.state or new.superseded_by is distinct from old.superseded_by)) then
      raise exception 'case file %: a case file never changes once opened, except to be ruled on or superseded, once', old.id
        using errcode = 'check_violation';
    end if;
    if new.state = 'ruled' and old.state = 'open'
       and not exists (select 1 from public.ruling r where r.case_file_id = new.id) then
      raise exception 'case file %: a case file is ruled only with its ruling', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
create trigger case_fixed before update or delete on ruling    for each row execute function kj_case_fixed();
create trigger case_fixed before update or delete on position  for each row execute function kj_case_fixed();
create trigger case_fixed before update or delete on case_file for each row execute function kj_case_fixed();
create trigger case_kept before truncate on ruling    for each statement execute function kj_case_fixed();
create trigger case_kept before truncate on position  for each statement execute function kj_case_fixed();
create trigger case_kept before truncate on case_file for each statement execute function kj_case_fixed();

-- A position is taken only on an open case file.
create function kj_position_on_open_case() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if (select c.state from public.case_file c where c.id = new.case_file_id) is distinct from 'open' then
    raise exception 'position %: case file % isn''t open', new.id, new.case_file_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger position_on_open_case before insert on position for each row execute function kj_position_on_open_case();

-- A person rules (CASE2, D51), never an agent: Kolab checks it before it writes, and the database
-- holds every new ruling to it too, whoever writes it. Security definer, since it reads actor.
create function kj_ruling_by_person() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (select 1 from public.actor a where a.id = new.actor_id and a.kind = 'person') then
    raise exception 'ruling %: % is not a person; only a person rules', new.id, new.actor_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function kj_ruling_by_person() from public;
create trigger ruling_by_person before insert on ruling for each row execute function kj_ruling_by_person();
