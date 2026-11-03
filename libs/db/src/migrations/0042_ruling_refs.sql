-- Migration 0042: a ruling's own name in its kolab, and when it was recorded (W6.3; D15, D104, D109).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- Konjir runs on Konjir (W6.3): the Decisions Log becomes the `kolab` kolab's rulings, each keeping
-- the ID it has always had (D109, D16) and the date it was given. A ruling's id stays a ULID, unique
-- across Konjir; `ref` is the name a person gives it in its kolab, unique there, such as D109, and
-- null for a ruling given without one. `ruled_at` may now be a date before the ruling was written,
-- for a ruling recorded after it was given; `recorded_at` is when Kolab wrote it, so the record
-- keeps both. Rows already here have no ref, and no recorded_at: nothing is guessed. A ruling still
-- never changes once given (kj_case_fixed, 0013), so neither does its ref.

alter table ruling add column ref text
  constraint ruling_ref_form check (ref ~ '^[A-Za-z][A-Za-z0-9._-]{0,39}$');
create unique index ruling_ref_per_kolab on ruling(kolab_id, ref) where ref is not null;

-- Added without a default, so the rows already here stay null; every ruling written from now on records it.
alter table ruling add column recorded_at timestamptz;
alter table ruling alter column recorded_at set default clock_timestamp();
