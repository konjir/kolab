import * as z from 'zod/v4';
import { MAX_DEPENDS_ON, MAX_DONE_WHEN, WORK_SIZES } from '@konjir/types';

/**
 * A work package's fields (PLN1, PLN3, D98), on a plan's elements only. Kolab checks them again
 * (checkWork), with the same refusals for every client. A field it doesn't know is refused, not dropped.
 */
export const workInput = z.strictObject({
  done_when: z.string().optional().describe(`When it is done: its definition of done, which its reviewer checks the evidence against. At most ${MAX_DONE_WHEN} characters.`),
  depends_on: z.array(z.string()).optional().describe(`The work packages of this plan it depends on, by element id: ["W1.1", "W1.2"]. At most ${MAX_DEPENDS_ON}. No cycles.`),
  size: z.enum(WORK_SIZES).optional().describe('S, M or L: it feeds the forecast. Nobody is asked for hours.'),
  milestone: z.boolean().optional().describe('A milestone has no work of its own: it depends on its members, its done-when is their exit criterion, and it delivers nothing.'),
  target_date: z.string().optional().describe('YYYY-MM-DD. Only a milestone carries a target date.'),
  repo: z.string().optional().describe('The repository it is done in, when not its binding\'s own (KON7).'),
}).describe('A work package\'s fields, on a plan\'s elements only. What it delivers is not a field: each Delivers is a dependency link from it to a binding element (links).');
