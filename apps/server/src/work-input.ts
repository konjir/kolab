import * as z from 'zod/v4';
import { args } from './args.js';
import { MAX_DEPENDS_ON, MAX_DONE_WHEN, WORK_SIZES } from '@konjir/types';

/**
 * A work package's fields (PLN1, PLN3, D98, D104), on a binding's elements only. Kolab checks them again
 * (checkWork), with the same refusals for every client. A field it doesn't know is refused, not dropped.
 */
export const workInput = args({
  done_when: z.string().optional().describe(`When it is done: its definition of done, which its reviewer checks the evidence against. At most ${MAX_DONE_WHEN} characters.`),
  depends_on: z.array(z.string()).optional().describe(`The work packages of this binding version it depends on, by element id: ["W1.1", "W1.2"]. At most ${MAX_DEPENDS_ON}. No cycles. A package split into child packages depends on them (PLN20).`),
  size: z.enum(WORK_SIZES).optional().describe('S, M or L: it feeds the forecast. Nobody is asked for hours. Not on a milestone, which has no work of its own.'),
  milestone: z.boolean().optional().describe('A milestone has no work of its own: it depends on its members, its done-when is their exit criterion, and it links nothing.'),
  target_date: z.string().optional().describe('YYYY-MM-DD. Only a milestone carries a target date.'),
  repo: z.string().optional().describe('The repository it is done in, when not its binding\'s own (KON7).'),
  release: z.boolean().optional().describe('true: it must be released. Its approval leaves it In review, approved, until its release (the deploy run and the commit it released) is recorded with konjir_record_release, which makes it Done (PLN16). Not on a milestone.'),
}).describe('A work package\'s fields, on a binding\'s elements only: an element with them is a work package ({} for one whose fields are still to come), one without is a decision. What it serves and relies on are not fields: each is a dependency link from it to a spec element or a decision of its binding (links).');
