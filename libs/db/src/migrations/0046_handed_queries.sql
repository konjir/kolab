-- Migration 0046: a question or note an answer job handed to a person waits on people (W7.9, JOB6).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- An answer job hands its item to a person by ending without answering it, its note beginning
-- "Handed to a person:". Until now that held the item back for an hour, after which another job
-- took it again. handed_off_at and handed_off_job_id record the hand-off on the query itself: no
-- job takes it again, and only a person answers it. Open queries already handed off are set from
-- their newest such job.
alter table query add column handed_off_at timestamptz, add column handed_off_job_id text references job(id);
alter table query add constraint query_handed_off_with_job check ((handed_off_at is null) = (handed_off_job_id is null));

update query q set handed_off_at = h.ended_at, handed_off_job_id = h.id
  from (select distinct on (j.query_id) j.query_id, j.id, j.ended_at from job j
         where j.kind = 'answer' and j.query_id is not null and j.outcome = 'released' and j.note ~ '^\s*Handed to a person:'
         order by j.query_id, j.ended_at desc, j.id desc) h
 where q.id = h.query_id and q.state = 'open';
