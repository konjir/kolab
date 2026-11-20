/**
 * `kolab <command> --help` (or -h): each command kolab runs itself prints its own usage, what it
 * does, its flags and an example, and exits 0, before kolab reads any other argument, a project's
 * .konjir.json or a sign-in, so it never talks to a Kolab or opens a browser. A verb Kolab serves,
 * passed through as `kolab <verb> key=value …`, is asked the same: `kolab help <verb>` answers it,
 * from the verbs Kolab lists (helpRequest). Kept in step with `kolab --help` (cli.ts) and README.md.
 */

/** One command's help: its usage lines, what it does, its flags and examples. */
interface CommandHelp {
  usage: string[]; does: string; flags?: [string, string][]; examples: string[];
  /** It talks to Kolab, so the connection flags apply. */
  connects?: boolean;
  /** The verb Kolab serves that it calls, whose own form (key=value, --json) it also takes. */
  verb?: string;
}

const CONNECTION = 'Connection: --url <kolab> and --token <token> (or KONJIR_URL and KONJIR_TOKEN); with no token, the sign-in kolab login keeps for that URL. kolab --help says where the URL comes from otherwise.';

/** Every command kolab runs itself, by the words that name it. */
export const COMMANDS: Record<string, CommandHelp> = {
  login: {
    usage: ['kolab login [--kolab <name>] [--role product|engineer] [--agent <label|agent>] [--url <kolab>]'],
    does: 'Signs in with your browser (GitHub, through Kolab): on Kolab\'s page you choose who this CLI works as (an agent of yours, by default), the kolab and the role. Every later command uses that sign-in, renewing it by itself. With no --url, it signs in to the Kolab the project\'s .konjir.json names, else this build\'s default.',
    flags: [
      ['--kolab <name>', 'preselects the kolab (over the project\'s .konjir.json)'],
      ['--role product|engineer', 'preselects the role'],
      ['--agent <label|agent>', 'preselects one agent of yours, by its label as kolab connect takes it (product, for <you>-product) or its full name, and refuses a sign-in as anyone else'],
      ['--url <kolab>', 'the Kolab to sign in to; give one a project\'s .konjir.json names once, here, to trust it'],
    ],
    examples: ['kolab login --kolab anns --role engineer --agent cli'],
  },
  logout: {
    usage: ['kolab logout [--forget] [--url <kolab>]'],
    does: 'Revokes the sign-in kolab login kept for the Kolab, and forgets it here.',
    flags: [['--forget', 'forgets the sign-in here without contacting Kolab (it lapses within 30 days unused)'], ['--url <kolab>', 'the Kolab whose sign-in to end']],
    examples: ['kolab logout', 'kolab logout --forget --url https://kolab.example.com/mcp'],
  },
  connect: {
    usage: ['kolab connect opencode|claude --kolab <k> [--agent <label>[:<role>]]… [--global] [--force] [--force-path] [--dry-run] [--no-auth] [--http] [--subagents] [--url <kolab>]'],
    does: 'Connects a harness to a kolab, one MCP entry per agent (by default product and engineer). It prints the plan (the entries, your agents <you>-<label>, the change to opencode.json or .mcp.json, or with --global your own settings) and opens your browser once, at Kolab\'s setup page: sign in, check the kolab and agents it names, and Allow. Kolab makes the kolab if no kolab has that name (private, yours) and each agent that is new. For Claude Code each entry is the Konjir channel (kolab bridge), each agent signed in; it ends with one kolab claude command per agent. Run it again: the same kolab and agents, signed in afresh.',
    flags: [
      ['--kolab <k>', 'the kolab (else the project\'s .konjir.json names it)'],
      ['--agent <label>[:<role>]', 'an agent, <you>-<label>, in role product or engineer (a label product or engineer is its own role); repeat it for more'],
      ['--global', 'writes your own settings, not the project\'s, and reads and writes no .konjir.json'],
      ['--force', 'replaces konjir-<label> entries already there, and repoints a .konjir.json that names another kolab or Kolab'],
      ['--force-path', 'writes a config file that links outside the project'],
      ['--dry-run', 'prints the plan and stops: nothing made, written or signed in'],
      ['--no-auth', 'signs no agent in now; the steps it prints say how each signs in'],
      ['--http', 'writes Claude Code\'s plain HTTP entry instead, with no channel; it signs in by itself'],
      ['--subagents', 'also writes one Claude Code subagent per agent, .claude/agents/<label>.md, with only that agent\'s Konjir tools'],
      ['--url <kolab>', 'the Kolab, by default the project\'s (.konjir.json), else https://kolab.konjir.com/mcp'],
    ],
    examples: ['kolab connect claude --kolab anns', 'kolab connect claude --kolab anns --agent pm:product --agent dev:engineer --dry-run'],
  },
  claude: {
    usage: ['kolab claude <label> [claude\'s arguments…]'],
    does: 'Starts one agent\'s Claude Code session: only its konjir-<label> entry and channel, written alone to .claude/konjir-<label>.json, and a system prompt naming the agent, its role and kolab. Everything after the label goes to claude, --help included.',
    flags: [['<label>', 'the label of an agent kolab connect claude set up, such as product']],
    examples: ['kolab claude product', 'kolab claude engineer --continue'],
  },
  bridge: {
    usage: ['kolab bridge'],
    does: 'The Konjir channel bridge: a stdio MCP server that Claude Code starts from the entry kolab connect claude wrote, with its Kolab, agent and scope in its environment (KONJIR_URL, KONJIR_AGENT, KONJIR_SCOPE). It takes no arguments, and isn\'t run by hand.',
    examples: ['kolab connect claude --kolab anns   # writes the entries that start it'],
  },
  work: {
    usage: ['kolab work [--jobs <n>] [--once] [--machine <label>] [--allow-all] [--harness <cmd>] [--repo <url>] [-C <dir>]', 'kolab work deliver …   (kolab work deliver --help)', 'kolab work guard …     (kolab work guard --help)'],
    does: 'Signed in as yourself, in a checkout of the kolab\'s registered repository: sets this machine to work. It takes jobs from Kolab (a package returned with changes requested, a review, a ready work package, then a question, note or mark on the technical layer, or a spec element nothing serves yet), each done by one of your pool agents in its own git worktree, by Claude Code run headless on your own model account. A job never merges or deploys. Ctrl-C (or SIGTERM, SIGHUP) stops every job and gives back what it held; a second Ctrl-C kills them at once. macOS and Linux only.',
    flags: [
      ['--jobs <n>', 'up to n jobs at once (4; the kolab\'s policy caps you, 4 by default, and the kolab, 8)'],
      ['--once', 'takes one job, waits for it to end and exits; with nothing to take, it says why and exits'],
      ['--machine <label>', 'names this machine (its hostname by default)'],
      ['--allow-all', 'gives each job every permission, not only edits, git, npm, npx, gh and kolab'],
      ['--harness <cmd>', 'runs another command in Claude Code\'s place (or KONJIR_HARNESS), split on spaces'],
      ['--repo <url>', 'the remote whose URL is the registered repository\'s, never a fork\'s origin'],
      ['-C <dir>', 'the checkout (this folder by default)'],
    ],
    examples: ['kolab work --once', 'kolab work --jobs 2 -C ~/src/orders'],
    connects: true,
  },
  'work deliver': {
    usage: [
      'kolab work deliver [<work>] [--submit] [--pr <url>] [--test <url|summary>]… [--check <spec address>=passed|failed]… [--note <text>] [--since <rev>] [--repo <url>] [--dry-run] [-C <dir>]',
      'kolab work deliver <work> --release <run URL> [--commit <rev>] [--title <text>] [--repo <url>] [--dry-run] [-C <dir>]',
    ],
    does: 'In a checkout: finds the commits whose trailer is the package\'s (Konjir-Work: kj:<kolab>/<binding>#<id>, from pull_work or read_work), checks the checkout is the registered repository (its root commit and a remote), and records them as evidence. Run again, it records only what is new. With --release, after the package\'s approval and the deploy, it records that a GitHub Actions run of that repository released the commit; a package with release: true, approved, is then Done.',
    flags: [
      ['<work>', 'the package, kj:<binding>#<id> (else the one this session holds)'],
      ['--submit', 'submits the package for review'],
      ['--pr <url>', 'the pull request'],
      ['--test <url|summary>', 'a test run, by its URL or a summary; repeat it for more'],
      ['--check <address>=passed|failed', 'an acceptance check the one --test ran, a committed spec element; repeat it for more'],
      ['--note <text>', 'a note for the reviewer'],
      ['--since <rev>', 'only commits after this one'],
      ['--release <run URL>', '<repository URL>/actions/runs/<id>: the run that released the commit'],
      ['--commit <rev>', 'the commit released (HEAD by default)'],
      ['--title <text>', 'the release\'s title'],
      ['--repo <url>', 'the remote whose URL is the registered repository\'s'],
      ['--dry-run', 'records nothing and says what it would do'],
      ['-C <dir>', 'the checkout (this folder by default)'],
    ],
    examples: ['kolab work deliver kj:orders-pg#W1 --submit --pr https://github.com/acme/orders/pull/7 --test "npm test: 212 passed"',
      'kolab work deliver kj:orders-pg#W1 --release https://github.com/acme/orders/actions/runs/123'],
    connects: true,
  },
  'work guard': {
    usage: ['kolab work guard --branch <the default branch>'],
    does: 'A job\'s guard hook: Claude Code runs it before each shell command in a job, with the command on stdin, and it denies (exit 2) a push that deletes, forces, mirrors or reaches the default branch, merging, gh api and terraform. It talks to no Kolab. kolab work writes it into each job\'s settings; it isn\'t run by hand.',
    flags: [['--branch <branch>', 'the repository\'s default branch']],
    examples: ['echo \'{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}\' | kolab work guard --branch main'],
  },
  'repo register': {
    usage: ['kolab repo register [--binding <binding>] [--url <url>] [--root <sha>] [-C <dir>]'],
    does: 'In a checkout, as a person with Maintain or Admin (never an agent): registers its repository for the binding, pinned by its root commit. Its own --url is the repository\'s: Kolab\'s comes from KONJIR_URL, the project\'s .konjir.json, or a --url before repo.',
    flags: [
      ['--binding <binding>', 'the binding the repository builds'],
      ['--url <url>', 'the repository\'s URL (its remote\'s by default)'],
      ['--root <sha>', 'its root commit (the checkout\'s by default)'],
      ['-C <dir>', 'the checkout (this folder by default)'],
    ],
    examples: ['kolab repo register --binding orders-pg'],
    connects: true,
  },
  status: {
    usage: ['kolab status [--json]'],
    does: 'The kolab\'s queue by kind, its live jobs (person, machine, agent, item, since) and your room under the caps.',
    flags: [['--json', 'prints it as JSON']],
    examples: ['kolab status'],
    connects: true,
  },
  import: {
    usage: ['kolab import <file.json> [--dry-run] [--update]'],
    does: 'Signed in as yourself (never an agent or a job): imports from one file what your role may write, into the kolab you are signed in to. Two passes, in either order: as product, for the spec and the rulings on it; then as engineer, for the binding, its work packages, the rulings on it and the repository (README.md, "Importing a kolab", gives the file\'s shape). Kolab checks the whole file first; run again, it changes nothing that is there and equal.',
    flags: [['--dry-run', 'writes nothing and says what it would do'], ['--update', 'drafts the file\'s version of a node whose latest committed version differs, as a new version reviewed as any is']],
    examples: ['kolab import kolab.json --dry-run'],
    connects: true,
    verb: 'import',
  },
  serve: {
    usage: ['kolab serve [--port 7420] [--data .konjir | --database-url postgres://…] [--admin-token T|off] [--public-host <host>] [--no-migrate] [--no-worker] [--quiet]'],
    does: 'Runs Kolab, from a checkout of github.com/konjir/kolab (the published kolab is the client only). Kolab runs structural checks only and makes no model calls; reviewing agents review. kolab --help lists the environment it reads (sign-in with GitHub, KONJIR_STUB_IDENTITY for local development, and the rest).',
    flags: [
      ['--port <n>', 'the port (7420)'],
      ['--data <dir>', 'the PGlite data folder (.konjir)'],
      ['--database-url <url>', 'a Postgres database instead (or KONJIR_DATABASE_URL)'],
      ['--admin-token <T|off>', 'the break-glass admin token (or KONJIR_ADMIN_TOKEN); off disables it; unset, a local Kolab makes one and prints it'],
      ['--public-host <host>', 'the host Kolab is served at (or KONJIR_PUBLIC_HOST)'],
      ['--no-migrate', 'applies no migration (a database that needs one is refused)'],
      ['--no-worker', 'runs no outbox jobs'],
      ['--quiet', 'doesn\'t print the admin token a local Kolab makes'],
    ],
    examples: ['bin/kolab serve', 'bin/kolab serve --database-url postgres://localhost/kolab --no-migrate --no-worker'],
  },
  watch: {
    usage: ['kolab watch [--once]'],
    does: 'Prints your inbox, then a JSON line each time it changes (questions, notes, answers, marks, review requests and verdicts).',
    flags: [['--once', 'waits for the next change, prints it and exits']],
    examples: ['kolab watch --once'],
    connects: true,
  },
  tools: {
    usage: ['kolab tools'],
    does: 'Every verb Kolab serves to this session, with its parameters (name=<type>, [optional]) and what it does.',
    examples: ['kolab tools'],
    connects: true,
  },
  instructions: {
    usage: ['kolab instructions [reviewer]'],
    does: 'The operating rules and your kolab\'s precedent (read this first); with reviewer, how to review a version that waits for you.',
    flags: [['reviewer', 'the reviewer\'s instructions instead']],
    examples: ['kolab instructions', 'kolab instructions reviewer'],
    connects: true,
    verb: 'instructions',
  },
  help: {
    usage: ['kolab help [<command>|<verb>]', 'kolab <command>|<verb> --help'],
    does: 'With nothing, kolab\'s own usage. With a command kolab runs itself (login, work deliver, …), its usage, from this kolab alone. With a verb Kolab serves, its description and each parameter, from the verbs Kolab lists to this session (kolab tools lists them all).',
    examples: ['kolab help', 'kolab help login', 'kolab help read_node'],
  },
  resolve: {
    usage: ['kolab resolve <address>'],
    does: 'Resolves an address, kj:[<kolab>/]<node>[@<version>][#<element>]: konjir_resolve address=<address>.',
    examples: ['kolab resolve kj:orders#R1'],
    connects: true,
    verb: 'resolve',
  },
  read: {
    usage: ['kolab read <node> [version]'],
    does: 'Reads a node, at its latest committed version or the one given: konjir_read_node node=<node> [version=<n>].',
    examples: ['kolab read orders', 'kolab read orders 3'],
    connects: true,
    verb: 'read_node',
  },
  stale: {
    usage: ['kolab stale [all]'],
    does: 'Lists what is stale on your layer, or with all on every layer: konjir_list_stale [all_layers=true].',
    examples: ['kolab stale all'],
    connects: true,
    verb: 'list_stale',
  },
  queries: {
    usage: ['kolab queries [all]'],
    does: 'Lists the open questions and notes on your layer, or with all on every layer: konjir_list_queries [all_layers=true].',
    examples: ['kolab queries'],
    connects: true,
    verb: 'list_queries',
  },
};

/** `kolab <command> --help`: a command's usage, what it does, its flags and examples. */
export function commandHelp(name: string): string {
  const h = COMMANDS[name];
  const width = Math.max(0, ...(h.flags ?? []).map(([f]) => f.length));
  return [
    ...h.usage,
    '',
    h.does,
    ...(h.flags?.length ? ['', ...h.flags.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`)] : []),
    '',
    h.examples.length === 1 ? 'Example:' : 'Examples:',
    ...h.examples.map((e) => `  ${e}`),
    ...(h.verb ? ['', `It calls the verb konjir_${h.verb}, and takes its own form too, key=value or --json: kolab help konjir_${h.verb} gives its parameters.`] : []),
    ...(h.connects ? ['', CONNECTION] : []),
  ].join('\n');
}

/** `kolab <verb> --help` with no sign-in and no token: how to see the verb's parameters, said without asking Kolab. */
export function verbHelpOffline(verb: string): string {
  const name = verb.replace(/^konjir_/, '');
  return [
    `kolab ${name} [key=value …]   (or --json '{…}')`,
    '',
    `Calls the verb konjir_${name} on Kolab. Its parameters are Kolab's, and kolab keeps no sign-in or token to ask Kolab for them: sign in (kolab login, or set KONJIR_TOKEN), then run kolab help ${name}, or kolab tools for every verb. docs/verbs.md in github.com/konjir/kolab lists them too.`,
  ].join('\n');
}

const HELP = ['--help', '-h'];
/** The flags, any command's, that take a value: a --help or -h after one is that value, not a request for help. */
const TAKES_VALUE = new Set(['--url', '--token', '--kolab', '--role', '--agent', '--port', '--data', '--admin-token', '--public-host', '--database-url', '--review',
  '--binding', '--root', '--pr', '--test', '--check', '--note', '--since', '--repo', '--release', '--commit', '--title', '--jobs', '--machine', '--harness', '--branch', '--json', '-C']);
/** The flags kolab takes for every command, before or after it. */
const GLOBAL = ['--url', '--token', '--kolab'];

/** The command `words` name, two words for the subcommands (work deliver, work guard, repo register), or undefined for a verb Kolab serves. */
function commandOf(words: string[]): string | undefined {
  const [first, second] = words;
  if (first === 'work') return second === 'deliver' || second === 'guard' ? `work ${second}` : 'work';
  if (first === 'repo') return 'repo register';
  return first !== undefined && Object.hasOwn(COMMANDS, first) && !first.includes(' ') ? first : undefined;
}

/**
 * What `kolab <argv…>` asks for help on, read from the arguments as given, before anything else is:
 * `{ command }` for a command kolab runs itself, whose usage it prints alone; `{ verb, argv }` for a
 * verb Kolab serves, whose help is `kolab help <verb>`, `argv` being that command, with the
 * connection flags given; or undefined when no help is asked for. Bare `kolab`, `kolab --help`,
 * `kolab help` and `kolab -h` are undefined too, but -h is turned into --help (`argv`), the usage of kolab.
 * Help is --help or -h anywhere after the command, but not as a flag's value (--note -h), and for
 * kolab claude only right after it: everything after the label is claude's.
 */
export function helpRequest(argv: string[]): { command: string } | { verb: string; argv: string[] } | { argv: string[] } | undefined {
  // The connection flags may come before the command.
  let at = 0;
  while (GLOBAL.includes(argv[at]) && at + 1 < argv.length) at += 2;
  const cmd = argv[at];
  const rest = argv.slice(at + 1);
  const globals = (from: string[]) => from.flatMap((a, k) => (GLOBAL.includes(a) && from[k + 1] !== undefined ? [a, from[k + 1]] : []));
  if (cmd === undefined) return undefined;
  if (cmd === 'help' || HELP.includes(cmd)) {
    const topic = rest.filter((a, k) => !GLOBAL.includes(a) && !GLOBAL.includes(rest[k - 1]));
    if (!topic.length) return cmd === '-h' ? { argv: [...argv.slice(0, at), '--help', ...rest] } : undefined;
    if (HELP.includes(topic[0])) return { command: 'help' };
    const command = commandOf(topic);
    if (command) return { command };
    // `kolab --help <verb>` and `kolab -h <verb>` are `kolab help <verb>`.
    return cmd === 'help' ? undefined : { verb: topic[0], argv: [...argv.slice(0, at), ...globals(rest), 'help', topic[0]] };
  }
  if (cmd === 'claude') return HELP.includes(rest[0]) ? { command: 'claude' } : undefined;
  if (cmd === '--version') return undefined;
  const asked = rest.some((a, k) => HELP.includes(a) && !TAKES_VALUE.has(rest[k - 1]));
  if (!asked) return undefined;
  const command = commandOf([cmd, ...rest]);
  if (command) return { command };
  return { verb: cmd, argv: [...argv.slice(0, at), ...globals(rest), 'help', cmd] };
}
