-- Migration 0044: the `kolab` kolab's spec and binding stop calling themselves mirrors (W6.3; D112).
-- Never edit this file once released: change the schema in a new migration (README.md, "Changing the schema").
--
-- D32 mirrored the claude.ai artifacts into Kolab under titles saying so. W6.3 imports the real spec
-- and binding onto those same nodes, and no verb changes a node's title, so this corrects those two
-- once, and the plan, retired by D104, says it is history. It matches each node's whole title in that
-- kolab alone, so it changes nothing else: another kolab's node, or a title that has since changed.
-- Nodes keep their names and versions, and the rule that a title is set when a node is made stands.
update node set title = 'Kolab — Functional Spec'
 where kolab_id = 'kolab' and name = 'kolab' and title = 'Kolab — Functional Spec (mirror of claude.ai, D32)';
update node set title = 'Kolab — Technical Binding'
 where kolab_id = 'kolab' and name = 'kolab-binding' and title = 'Kolab — Technical Binding (mirror of claude.ai, D32)';
update node set title = 'Kolab — Plan (history, D104)'
 where kolab_id = 'kolab' and name = 'kolab-plan' and title = 'Kolab — Plan (mirror of claude.ai, D32)';
