import { Inject, Injectable } from '@nestjs/common';
import { McpPrompt } from '@onivoro/server-mcp';
import { Kolab } from '@konjir/engine';
import { KOLAB } from './tokens.js';

export const INSTRUCTIONS = `Konjir holds the canonical specs, bindings and work for this project. Your session token fixes your actor and role (product writes the functional layer; engineer writes the technical layer).
Rules:
1. Fetch fresh. Resolve addresses with konjir_resolve when you need them; never copy spec text into local files, readmes or comments.
2. Address precisely. kj:<node>[@<version>][#<element>][~q({"exact":"…","prefix":"…","suffix":"…"})]. Link from the element you are writing to the element you rely on. A quoted span stays exact only while its words stand with the prefix or suffix you quoted; edited words, or the same words elsewhere without that context, are marked fuzzy_reanchor.
3. Never change behavior from the technical layer. If the spec can't be met as written, konjir_ask the spec, don't patch around it. Pass from=<your element> so the answer comes back to that element as a mark. To flag an interpretation or assumption that needs no answer, konjir_annotate the spec.
4. Drafts are not truth until review commits them. Nothing may link to an uncommitted version.
5. Before finishing work, run konjir_list_stale and handle every mark on your layer.
6. Your inbox is pushed. If your client supports subscriptions/listen, subscribe to the resources konjir_whoami lists and re-read one when it is updated. Otherwise, while you wait on answers, run \`konjir watch --once\` (the konjir CLI, with KONJIR_URL and KONJIR_TOKEN set) as a background command: it exits with the change as soon as your inbox has one.`;

const MORE = 'Full operating instructions and precedent: the konjir_operating_instructions MCP prompt, or run `konjir instructions` in a shell.';

/** Served as the server's instructions, so the rules arrive with the connection. */
export const SERVER_INSTRUCTIONS = `${INSTRUCTIONS}\n${MORE}`;

/** The konjir_operating_instructions prompt: the rules plus precedent and answered questions. */
@Injectable()
export class OperatingInstructions {
  constructor(@Inject(KOLAB) private readonly kolab: Kolab) {}

  @McpPrompt({
    name: 'konjir_operating_instructions',
    title: 'Konjir operating instructions',
    description: 'The rules for working through Konjir, plus recent precedent so settled questions are not re-litigated.',
  })
  async operatingInstructions() {
    const prec = (await this.kolab.db.query<{ resolution: string; amended_text: string | null; ruled_by: string }>(
      `select resolution, amended_text, ruled_by from precedent order by id desc limit 20`)).rows;
    const answered = await this.kolab.listQueries({ state: 'answered' });
    const text = [
      INSTRUCTIONS,
      '',
      'Working loop: konjir_whoami, then konjir_list_stale and konjir_list_queries for your layer (and konjir_list_queries mine=true for answers to your own questions); resolve what you need with konjir_resolve; draft with links, submit for review; finish by checking konjir_list_stale again.',
      'Answering questions: if the answer settles or changes intent, also amend the spec element and commit it. The answer alone reaches only the asker; the spec change reaches everyone who depends on that element, through the cascade.',
      '',
      'Writing specs (product): intent and behavior only, one testable requirement per element, readable stable IDs (e.g. R1, R2 or a feature prefix like PR1). Reuse an element\'s ID when you edit it; a new ID means a new requirement. To edit, draft with deltas (override/add/remove) rather than resending everything.',
      'Writing bindings and work (engineer): one element per implementation decision; link each element to exactly the requirement(s) it serves, with source_element set. Questions about intent go to the spec with konjir_ask; never encode a behavior change in a binding.',
      'Questions and notes: ask on the narrowest address (an element, or a quoted span with ~q). Set from to your element that waits on the answer; when it is answered that element gets a query_answered mark, which editing the element or konjir_clear_mark settles. Use konjir_annotate for an interpretation or assumption you are proceeding on, so the owner can object; it blocks nothing. Both show beside the element in konjir_read_node.',
      'Variants: when a parent commits, Kolab rebases each variant onto it. A rebase that fails for the variant\'s own reasons (its review rejects it or can\'t run) leaves the variant on its old parent with one rebase_failed mark and a question saying why; a later failure re-points that mark rather than adding another. Commit a version that resolves it, either on your current parent (Kolab then rebases it) or with parent set to the parent\'s latest version; the mark and its question settle once the variant sits on its parent\'s latest version.',
      'Edge kinds: dependency = this element relies on that one (the usual choice); derivation = this element was generated from that one (e.g. a WBS item from a binding element); equivalence = two representations that must stay in sync (spec and prototype). All three are re-checked the same way when the target changes.',
      'Links inside one spec are allowed: they say one requirement relies on another, and Kolab re-checks them when the target requirement changes.',
      '',
      `Precedent on stale overrides (${prec.length}): ` + (prec.map((p) => `${p.resolution}${p.amended_text ? ` -> "${p.amended_text}"` : ''} (ruled by ${p.ruled_by})`).join('; ') || 'none yet'),
      `Answered questions and notes (${answered.length}): ` + (answered.slice(-20).map((q) => `${q.address}: ${q.kind === 'note' ? 'note' : 'asked'} "${q.question}" -> "${q.answer}"`).join('; ') || 'none yet'),
    ].join('\n');
    return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
  }
}
