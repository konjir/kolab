import * as z from 'zod/v4';
import { PAGE_DEFAULT, PAGE_MAX } from '@konjir/types';

/** Every list verb's paging parameters (W2.21, D71): where to start, and how many. */
export const paging = {
  cursor: z.string().optional().describe('The next a previous call returned, to read the page after it, with the same other parameters. Omit it for the first page.'),
  limit: z.number().int().optional().describe(`How many to return: ${PAGE_DEFAULT} by default, at most ${PAGE_MAX}.`),
};

/** What a list verb's description says of its paging. */
export const PAGED = ` Paged: returns at most limit items (${PAGE_DEFAULT} by default, at most ${PAGE_MAX}) and next. While next isn't null there are more: call again with cursor=next to read them.`;
