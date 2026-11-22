/**
 * The phone's sign-ins, one per team: the client it registered for that team's sign-in, its
 * rotating refresh token and the access token in use, kept in the secure store (expo-secure-store:
 * the Keychain on iOS, the Keystore on Android), never anywhere else. Each Kolab, by its MCP URL,
 * has its own: a dev build pointed at a local Kolab never sees production's.
 *
 * Every write lands before what it replaces is let go: a rotated refresh token is saved before
 * anything uses the new access token, and the old one is never kept beside it.
 */

/** The secure store, as the app uses it; tests stand a Map in its place. */
export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** One person's sign-in to one team. */
export interface TeamLogin {
  /** The team (the kolab) it is in, and who the person is there. */
  team: string; actor: string; role: string;
  /** The Kolab MCP URL it was made at. */
  url: string;
  /** The client registered for this sign-in (dynamic registration), a public client. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token ends, in ms since the epoch. */
  expiresAt: number;
}

/** What the rest of the app may know of a sign-in: nothing that works as a credential. */
export type TeamSummary = Pick<TeamLogin, 'team' | 'actor' | 'role'>;

/** Secure store keys allow letters, digits, '.', '-' and '_' only. */
const keyPart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

export class LoginStore {
  private readonly ns: string;
  /** Writes one at a time, so the index never loses a team two writes added at once. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: SecureKV, url: string) {
    const u = new URL(url);
    this.ns = `konnect.${keyPart(`${u.host}${u.pathname}`)}`;
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private loginKey = (team: string) => `${this.ns}.login.${keyPart(team)}`;
  private indexKey = () => `${this.ns}.teams`;
  private currentKey = () => `${this.ns}.current`;

  /** The teams signed in to, in the order they were added. */
  async teams(): Promise<string[]> {
    const raw = await this.kv.get(this.indexKey());
    if (!raw) return [];
    try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []; } catch { return []; }
  }

  async get(team: string): Promise<TeamLogin | undefined> {
    const raw = await this.kv.get(this.loginKey(team));
    if (!raw) return undefined;
    try { return JSON.parse(raw) as TeamLogin; } catch { return undefined; }
  }

  async summaries(): Promise<TeamSummary[]> {
    const out: TeamSummary[] = [];
    for (const team of await this.teams()) {
      const l = await this.get(team);
      if (l) out.push({ team: l.team, actor: l.actor, role: l.role });
    }
    return out;
  }

  /** Keeps `login`, replacing the team's earlier one: the record first, then the index. */
  put(login: TeamLogin): Promise<void> {
    return this.serial(async () => {
      await this.kv.set(this.loginKey(login.team), JSON.stringify(login));
      const teams = await this.teams();
      if (!teams.includes(login.team)) await this.kv.set(this.indexKey(), JSON.stringify([...teams, login.team]));
    });
  }

  /** Forgets the team's sign-in, and the current team if it was that one. */
  remove(team: string): Promise<void> {
    return this.serial(async () => {
      await this.kv.set(this.indexKey(), JSON.stringify((await this.teams()).filter((t) => t !== team)));
      await this.kv.remove(this.loginKey(team));
      if ((await this.kv.get(this.currentKey())) === team) await this.kv.remove(this.currentKey());
    });
  }

  /** The team the app shows: the one last switched to, if it is still signed in, else the first. */
  async current(): Promise<string | undefined> {
    const teams = await this.teams();
    const chosen = await this.kv.get(this.currentKey());
    return chosen && teams.includes(chosen) ? chosen : teams[0];
  }

  setCurrent(team: string): Promise<void> {
    return this.serial(() => this.kv.set(this.currentKey(), team));
  }
}
