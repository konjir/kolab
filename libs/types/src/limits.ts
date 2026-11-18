/**
 * Kolab's size limits and page sizes, in one place (W2.21, P13, D71): so one huge draft, question
 * or list can't stall the shared server, and every refusal names the limit it hit. The engine
 * enforces each one; the server and the web interface only describe them. A quoted span's limit
 * stays with the quote grammar, as MAX_QUOTE in @konjir/address (1,000 characters, DAT6).
 */

/** A list's page when no limit is asked for. */
export const PAGE_DEFAULT = 50;
/** The most a list returns in one page, whatever limit is asked for. */
export const PAGE_MAX = 200;

/**
 * Elements in one version. Kolab's own functional spec, its largest node, has a few hundred; a
 * thousand leaves room for that to grow several times while a read of one version, its diff and
 * its structural checks stay well under a second.
 */
export const MAX_ELEMENTS = 1000;
/**
 * Characters in one element's text: about 1,300 words, many times a requirement's usual length.
 * Longer than that is a document pasted into one element, and is split into elements instead.
 */
export const MAX_ELEMENT_TEXT = 8000;
/**
 * A version's whole text, in UTF-8 bytes: every element's id, text and parent. 512 KiB is about
 * 80,000 words, room for a thousand long elements, and well inside the 2 MiB request body the
 * server takes (MAX_REQUEST_BYTES).
 */
export const MAX_VERSION_BYTES = 512 * 1024;
/**
 * Characters in a question, a note, an answer, a review note or a finding's explanation, and in a
 * case file's question, a position's claim and a ruling's text: about 650 words. What needs more is
 * a spec change, or evidence linked by address.
 */
export const MAX_TEXT = 4000;
/**
 * Characters in a message, direct or in a channel: about 5,000 words. A message isn't a question or
 * a note (MAX_TEXT): a member pastes a log or a diff into one. A read returns at most
 * MESSAGES_AT_ONCE of them, so one read stays well inside what a request or an agent's turn takes.
 */
export const MAX_MESSAGE_TEXT = 32000;
/** Items of evidence on one position: each an address or a line of text. */
export const MAX_EVIDENCE = 20;
/** Characters in one item of evidence. */
export const MAX_EVIDENCE_TEXT = 1000;
/** Characters in a work package's done-when (PLN1, D98; migration 0029's kj_work_valid): as many as a question's. */
export const MAX_DONE_WHEN = MAX_TEXT;
/** Work packages one work package depends on (PLN1, D98; kj_work_valid). A milestone with more members is split into nested milestones. */
export const MAX_DEPENDS_ON = 50;
/** Characters in a work package's repo, the URL of a repository registered in its kolab (KON7, D98; kj_work_valid). */
export const MAX_WORK_REPO = 200;
/** Characters in a repository's URL (KON7, D98; migration 0032's repository_url): as many as a work package's repo, which names it. */
export const MAX_REPOSITORY_URL = MAX_WORK_REPO;
/** Live repositories one kolab registers (KON7, D98): a binding's implementation and its dependencies', not an organization's every repository. */
export const MAX_REPOSITORIES_PER_KOLAB = 100;
/** Items of evidence one call records on a work package (konjir_add_evidence, konjir_submit_work; D98). */
export const MAX_EVIDENCE_PER_CALL = 50;
/** Items of evidence one work package holds (D98): a delivery is tens of commits, not thousands. */
export const MAX_EVIDENCE_PER_PACKAGE = 500;
/** Paths one commit's evidence names (D98; migration 0031's evidence_files). */
export const MAX_EVIDENCE_FILES = 500;
/** Characters in one path a commit touched (D98). */
export const MAX_EVIDENCE_PATH = 1024;
/** Acceptance checks one test run lists (REV9; migration 0048's kj_evidence_checks_valid). */
export const MAX_EVIDENCE_CHECKS = 200;
/** Characters in an evidence link (D98; migration 0031's evidence_url). */
export const MAX_EVIDENCE_URL = 2000;
/** Findings in one review verdict. */
export const MAX_FINDINGS = 100;
/** Elements and rulings one answer cites (AUT4, POL3; migration 0041's query_answer_cites). */
export const MAX_CITES = 20;
/** Characters in a node's title. */
export const MAX_TITLE = 200;
/** Characters in a kolab's title (D54), whoever makes the kolab. */
export const MAX_KOLAB_TITLE = 100;
/** Characters in an actor's or an account's id or display name, and a team's name, as the admin gives them. */
export const MAX_NAME = 100;
/**
 * The largest request body the server parses, in bytes, on the MCP endpoint and the web API
 * alike: a full version at MAX_VERSION_BYTES, with JSON's quoting and the call around it.
 */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/**
 * The largest request body the server parses anywhere else: the OAuth routes, and anything else a
 * caller reaches before signing in. Nest's own default, 100 KiB, is far more than a sign-in form.
 */
export const MAX_SMALL_REQUEST_BYTES = 100 * 1024;
/**
 * Elements konjir_read_node returns per page, with the questions, rulings and case files beside
 * them. A version holds at most MAX_ELEMENTS, so most reads take one page; a larger one says so
 * and gives the cursor to the rest.
 */
export const READ_NODE_PAGE = 250;
/** Questions and notes shown beside one element in konjir_read_node, newest; the rest are counted, and listed by konjir_list_queries. */
export const THREADS_PER_ELEMENT = 20;

/** A list's page: its items, and the cursor to the next page, or null on the last. */
export interface Page<T> { items: T[]; next: string | null }

/** How many characters a text runs to, as the limits count them: by code point, so an emoji counts once. */
export const textLength = (s: string) => [...s].length;

/**
 * The window the rates below are counted over, in milliseconds: the last hour, sliding, counted in
 * the database (as a person's new kolabs are, D54), so every server process sees the same count and
 * a restart doesn't reset it. Each rate is a budget a person shares with their agents: an agent's
 * questions and drafts count against its owner, so making agents, or archiving and making them
 * again, doesn't raise it. An organization's agents share one budget of the organization's, with
 * limits of its own (MAX_ORG_ASKS_PER_HOUR, MAX_ORG_DRAFTS_PER_HOUR). A budget counts events: each
 * ask and each draft counts from the moment its call takes its place, whatever then becomes of what
 * it wrote (ruled 2026-10-23). A call takes its place under a lock per owner, held only while it
 * counts and holds that place, and its write marks the place used as it commits (kj_rate_take,
 * rate_event, 0025), so calls at once take turns, the limit holds, and no burst holds the lock
 * through its writes.
 */
export const RATE_WINDOW_MS = 60 * 60_000;
/**
 * Questions and notes a person and their agents raise in RATE_WINDOW_MS, across every kolab. One a minute,
 * sustained, is more than a person types and more than an agent's working loop asks of the spec it
 * is working through (Kolab's own agents ask a few an hour); an agent stuck asking the same thing
 * in a loop is stopped within the hour, before it buries the layer that must answer.
 */
export const MAX_ASKS_PER_HOUR = 60;
/**
 * Drafts a person and their agents make in RATE_WINDOW_MS, across every kolab: konjir_draft and
 * the web interface's submit, and the resolution of an override mark, each refused once they have made this many drafts in the window.
 * A draft counts when it is made, whatever happens to it after: submitted by its author or by
 * anyone else, approved, rejected, folded or abandoned (ruled 2026-10-23). So another writer
 * submitting someone's drafts frees none of their budget, and a second account can't launder it.
 * Two a minute, sustained, covers an agent that drafts, is refused by the structural checks and
 * drafts again, and a person editing quickly; a runaway loop is stopped within the hour, at 120
 * versions rather than thousands. Kolab's own rebases and folds, and an admin's applied ruling,
 * aren't drafts anyone made, so they neither count nor are limited.
 */
export const MAX_DRAFTS_PER_HOUR = 120;
/**
 * How many times a person's budget an organization's is: its agents, however many members drive
 * them, share one budget of the organization's. Five, because an organization's agents work for
 * several people at once, and five members' worth of agents at the per-person rate is a small team
 * working flat out, while a harness looping across every agent of the organization is still
 * stopped within the hour at hundreds of writes, not thousands. A larger organization that needs
 * more is a reason to raise these, not to give each agent a budget of its own.
 */
export const ORG_RATE_MULTIPLE = 5;
/** Questions and notes an organization's agents raise together in RATE_WINDOW_MS, across every kolab: 300. */
export const MAX_ORG_ASKS_PER_HOUR = ORG_RATE_MULTIPLE * MAX_ASKS_PER_HOUR;
/** Drafts an organization's agents make together in RATE_WINDOW_MS, across every kolab, counted as MAX_DRAFTS_PER_HOUR's are: 600. */
export const MAX_ORG_DRAFTS_PER_HOUR = ORG_RATE_MULTIPLE * MAX_DRAFTS_PER_HOUR;
/**
 * Messages a person and their agents send in RATE_WINDOW_MS, across every kolab (konjir_send_message),
 * counted as MAX_ASKS_PER_HOUR's are, in a budget of their own: four a minute, sustained, is a
 * conversation between agents at working pace, and two agents answering each other in a loop are
 * stopped within the hour.
 */
export const MAX_MESSAGES_PER_HOUR = 240;
/** Messages an organization's agents send together in RATE_WINDOW_MS, across every kolab: 1,200. */
export const MAX_ORG_MESSAGES_PER_HOUR = ORG_RATE_MULTIPLE * MAX_MESSAGES_PER_HOUR;
/** Unread messages the answers resource and konjir_read_messages give at once, oldest first. */
export const MESSAGES_AT_ONCE = 20;
/**
 * A channel's name (migration 0052): 1 to 40 lowercase letters, digits and hyphens, starting with a
 * letter or a digit, unique in its kolab. Every kolab has `general` (GENERAL_CHANNEL), which a
 * member follows unless they unfollow it.
 */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const GENERAL_CHANNEL = 'general';
/** Members one channel message may mention: enough to name a team, few enough that a mention still means someone. */
export const MAX_MENTIONS = 20;
/**
 * How many messages an agent sends in a kolab that could wake an agent (channel messages, and
 * direct messages to agents), with none from a person anywhere in the kolab, before its further
 * ones wake no agent until a person posts: a kolab's default, which its owner may change
 * (kolab_chat.agent_reply_cap, 1 to MAX_AGENT_REPLY_CAP). Each agent has its own count, so one
 * member's agents never silence another's. Two agents answering each other stop waking each other
 * here, well inside the message rate.
 */
export const DEFAULT_AGENT_REPLY_CAP = 100;
export const MAX_AGENT_REPLY_CAP = 100_000;
/** Channels a kolab holds at most, `general` among them: a channel is never removed, so this bounds what every member's answers walk. */
export const MAX_CHANNELS = 200;
/**
 * The most unread messages, or mentions, Kolab counts in one channel for one member: past it, the
 * count stops there and says there are more (unread_more, mentions_more), so a member who has never
 * read a long channel costs no more to serve than one who has read most of it.
 */
export const UNREAD_COUNT_CEILING = 1000;
/**
 * A lease's name (migration 0054): 1 to 200 letters, digits and `. _ / @ : -`, so a test database,
 * a port or a file's path (`testdb`, `port-3000`, `apps/server/src/x.ts`); compared exactly as given.
 */
export const LEASE_NAME = /^[A-Za-z0-9._/@:-]{1,200}$/;
/** How long a lease is held, in seconds: at least a minute, at most four hours, a quarter of an hour when not said. */
export const MIN_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 4 * 60 * 60;
export const DEFAULT_LEASE_SECONDS = 15 * 60;
/** The longest note a lease carries, saying what its holder is doing with it. */
export const MAX_LEASE_NOTE = 200;
/** The most leases one member holds in a kolab at once, and the most a kolab holds. */
export const MAX_LEASES_PER_MEMBER = 64;
export const MAX_LEASES = 500;
