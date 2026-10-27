-- Migration 0028: which of several sign-ins a request is, for its consent page to say (D97).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- `konjir connect` signs several agents in, one browser page each. Each request may say it is the
-- Nth of M (GET /oauth/authorize's `step` and `steps`), so the page locked to its agent can say
-- "agent N of M". Display only: it is never part of the scope and grants nothing. Kolab keeps the
-- two numbers only when both are whole numbers from 1 to 99, N no more than M; otherwise neither.

alter table oauth_request
  add column step smallint,
  add column steps smallint,
  -- Both or neither, written so a null on one side can't pass for true (a check passes on null).
  add constraint oauth_request_step check (
    (step is null) = (steps is null) and (step is null or (step between 1 and 99 and steps between 1 and 99 and step <= steps)));
