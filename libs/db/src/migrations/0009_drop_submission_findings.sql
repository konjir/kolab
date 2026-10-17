-- Migration 0009: Kolab's checks report no findings (W1.7; REV5, VER5, VER7).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- 0007 kept on a version in review the layer leaks that Kolab's checks found at submission, which
-- only the Bedrock reviewer ever reported. Kolab makes no model calls now: its checks are
-- structural, and findings come only from reviewers, on their review requests
-- (review_request.findings), which stay. The test server never ran the Bedrock reviewer, so the
-- column holds nothing there; anywhere else, a leak it holds is on a version still in review, and
-- its reviewer reports it with konjir_review instead.

alter table version drop column findings;
