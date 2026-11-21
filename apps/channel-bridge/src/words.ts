/**
 * Kolab's own words for the CLI, as the kolab command says them. The server words its texts for a
 * client that says it is `kolab` (KOLAB_CLIENT; step 1b of docs/plans/rebrand-and-site.md), but
 * @konjir/login's own texts, and the server's wherever that opt-in doesn't reach, still tell a
 * person to run `konjir login`, `konjir connect` and the like, the command's name before the
 * rename. Where kolab, or its channel, prints such a
 * text, it says `kolab` instead, as konnect's konnectWords makes them konnect's. Only the
 * command followed by one of its own subcommands changes: `konjir_<verb>` tools, `kj:` and
 * `konjir://` addresses, `konjir-<label>` entries and `konjir kolab:…` scopes stay as they are.
 */

/**
 * The kolab command's subcommands that the server's and @konjir/login's texts name: the same list as
 * the server's own wording (apps/server/src/wording.ts, COMMANDS), which
 * apps/cli/test/server-wording.test.ts holds equal to it.
 */
export const KOLAB_COMMANDS = ['login', 'logout', 'connect', 'import', 'work', 'instructions', 'watch', 'claude', 'bridge', 'repo', 'serve', 'tools', 'help', 'status', 'whoami'];
const KONJIR_COMMAND = new RegExp(`\\bkonjir (${KOLAB_COMMANDS.join('|')})\\b`, 'g');

/** `text` with each `konjir <subcommand>` said as `kolab <subcommand>`. */
export const kolabWords = (text: string): string => text.replace(KONJIR_COMMAND, 'kolab $1');

/** Every string in `value`, through kolabWords. */
const allWords = (value: unknown): unknown => typeof value === 'string' ? kolabWords(value)
  : Array.isArray(value) ? value.map(allWords)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, allWords(v)]))
  : value;

/**
 * `value` with the server's hints said as kolab says them: what is under a key named `next`, at any
 * depth, through kolabWords. Nothing else is touched, since the rest of a result is the kolab's
 * own content (a spec's text may well quote `konjir work`).
 */
export function kolabHints<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => kolabHints(v)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'next' ? allWords(v) : kolabHints(v)])) as T;
}

/** What the kolab CLI and its channel tell Kolab they are, at MCP's initialize: the opt-in to the server's kolab wording (1b). */
declare const KONJIR_VERSION: string | undefined;
export const KOLAB_CLIENT = { name: 'kolab', version: typeof KONJIR_VERSION === 'string' ? KONJIR_VERSION : 'development' } as const;
