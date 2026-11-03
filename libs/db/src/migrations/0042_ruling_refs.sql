-- Migration 0042: a ruling's own name in its kolab, and when it was recorded (W6.3; D15, D104, D109).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Konjir runs on Konjir (W6.3): the Decisions Log becomes the `kolab` kolab's rulings, each keeping
-- the ID it has always had (D109, D16) and the date it was given. A ruling's id stays a ULID, unique
-- across Konjir; `ref` is the name a person gives it in its kolab, unique there, such as D109, and
-- null for a ruling given without one. `ruled_at` may now be a date before the ruling was written,
-- for a ruling an import records after it was given; `recorded_at` is when Kolab wrote it, so the
-- record keeps both, and the audit log gains `ruling.backdated` for each such ruling. Rows already here have no ref, and no recorded_at: nothing is guessed. A ruling still
-- never changes once given (kj_case_fixed, 0013), so neither does its ref, and a date that can't be
-- read back would stay for good, so none before 2000 is written from now on (`not valid`: rows
-- already here aren't read for it).

alter table ruling add column ref text
  constraint ruling_ref_form check (ref ~ '^[A-Za-z][A-Za-z0-9._-]{0,39}$');
create unique index ruling_ref_per_kolab on ruling(kolab_id, ref) where ref is not null;

alter table ruling add constraint ruling_ruled_since check (ruled_at >= timestamptz '2000-01-01 00:00:00+00') not valid;

-- Added without a default, so the rows already here stay null; every ruling written from now on records it.
alter table ruling add column recorded_at timestamptz;
alter table ruling alter column recorded_at set default clock_timestamp();

alter table audit_event drop constraint audit_event_action_check;
alter table audit_event add constraint audit_event_action_check check (action in
  ('grant.set', 'grant.removed', 'member.set', 'member.removed',
   'team_member.added', 'team_member.removed', 'outbox.retried',
   'admin.granted', 'admin.revoked', 'admin.elevated', 'admin.lowered', 'break_glass.used',
   'work_lease.set', 'repository.registered', 'repository.archived', 'policy.set', 'ruling.backdated'));   -- AUDIT_ACTIONS in @konjir/types
