-- Migration 0012: rulings record their date, and case files, positions and rulings get the
-- columns their verbs need (W2.14; DAT9, CASE1–CASE7, D16, D50).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- A disagreement agents can't settle becomes a case file: what is disputed, about an element,
-- and two positions, each a claim with its evidence (CASE1). A person rules on it, sustaining or
-- overruling each position (CASE2), or rules directly with no case file (CASE3, D16; 0005). Every
-- ruling records its author and date, and is served back as precedent in its kolab (CASE4,
-- TEN13). A ruling either changes the intent or keeps it and asks for another way (CASE6).
--
-- Every row here is written by Kolab's verbs, as kj_system, after Kolab's checks: no agent writes
-- a case file, a position or a ruling directly (0006 gives kj_agent no insert on them). An agent
-- reads those of its session's kolab (0006's kolab_read).
--
-- No verb wrote these tables before this release, so the rows already there are the ones tests
-- and earlier migrations made by hand. Their dates and authors were never recorded and aren't
-- guessed: the checks below bind new rows only (not valid), as 0002's actor_id_check does.

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

-- A case file is ruled on once: its ruling is the one that set its state to ruled.
create unique index one_ruling_per_case_file on ruling(case_file_id) where case_file_id is not null;

-- ---------------------------------------------------------------------------
-- Case files and positions: who, when, and what is disputed (CASE1)
-- ---------------------------------------------------------------------------

alter table case_file add column question text;
alter table case_file add column opened_by text;
alter table case_file add column opened_at timestamptz;
alter table case_file alter column opened_at set default clock_timestamp();
alter table case_file add constraint case_file_opened check (question is not null and opened_by is not null and opened_at is not null) not valid;

alter table position add column created_at timestamptz;
alter table position alter column created_at set default clock_timestamp();
alter table position add constraint position_dated check (created_at is not null) not valid;
-- Each actor takes one position on a case file.
create unique index one_position_per_actor on position(case_file_id, actor_id);

-- What the read policies filter on, and how a case file finds its positions.
create index case_file_kolab on case_file(kolab_id);
create index position_case_file on position(case_file_id);
create index ruling_kolab on ruling(kolab_id);

-- ---------------------------------------------------------------------------
-- A ruling stands as given (stare decisis)
-- ---------------------------------------------------------------------------

-- Precedent is only precedent if it can't be rewritten: a ruling never changes once given, for
-- any role. A later ruling says what it overrules (`replaces`) instead. A position's claim and
-- evidence never change; only its verdict is set, once, by the ruling. A case file's subject and
-- question never change; it moves from open to ruled, once.
create function kj_case_fixed() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_table_name = 'ruling' then
    raise exception 'ruling %: a ruling never changes once given; give another that replaces it', old.id
      using errcode = 'check_violation';
  elsif tg_table_name = 'position' then
    if new.id is distinct from old.id or new.case_file_id is distinct from old.case_file_id
       or new.actor_id is distinct from old.actor_id or new.claim is distinct from old.claim
       or new.evidence is distinct from old.evidence or new.created_at is distinct from old.created_at
       or (old.verdict is not null and new.verdict is distinct from old.verdict) then
      raise exception 'position %: a position never changes once taken; only its ruling sets its verdict, once', old.id
        using errcode = 'check_violation';
    end if;
  elsif tg_table_name = 'case_file' then
    if new.id is distinct from old.id or new.version_id is distinct from old.version_id
       or new.element_id is distinct from old.element_id or new.question is distinct from old.question
       or new.opened_by is distinct from old.opened_by or new.opened_at is distinct from old.opened_at
       or (old.state = 'ruled' and new.state is distinct from old.state) then
      raise exception 'case file %: a case file never changes once opened, except to be ruled on, once', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;
create trigger case_fixed before update on ruling    for each row execute function kj_case_fixed();
create trigger case_fixed before update on position  for each row execute function kj_case_fixed();
create trigger case_fixed before update on case_file for each row execute function kj_case_fixed();

-- A person rules (CASE2), never an agent: Kolab checks it before it writes, and the database
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
