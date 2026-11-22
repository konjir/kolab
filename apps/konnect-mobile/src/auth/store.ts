/**
 * The phone's one sign-in: a person signs in once, with GitHub, and moves between the teams their
 * account belongs to (konjir_switch_team). One client registration, one rotating refresh token, the
 * access token in use and the team it is for, kept in the secure store (expo-secure-store: the
 * Keychain on iOS, the Keystore on Android), never anywhere else. Each Kolab, by its MCP URL, has
 * its own: a dev build pointed at a local Kolab never sees production's.
 *
 * A write lands before what it replaces is let go: a rotated refresh token is saved before anything
 * uses the new access token.
 */

/** The secure store, as the app uses it; tests stand a Map in its place. */
export interface SecureKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The person's sign-in. */
export interface Login {
  /** Who the person is (their GitHub login, which is their Kolab name), the team the tokens are for, and their role there. */
  actor: string; team: string; role: string;
  /** The Kolab MCP URL it was made at. */
  url: string;
  /** The client registered for this sign-in (dynamic registration), a public client. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token ends, in ms since the epoch. */
  expiresAt: number;
}

/** What the rest of the app may know of the sign-in: nothing that works as a credential. */
export type Who = Pick<Login, 'actor' | 'team' | 'role'>;

/** A sign-in from before one login (one per team), kept only to be revoked and forgotten. */
export type LegacyLogin = Pick<Login, 'team' | 'clientId' | 'refreshToken'>;

/** Secure store keys allow letters, digits, '.', '-' and '_' only. */
const keyPart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

export class LoginStore {
  private readonly ns: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: SecureKV, url: string) {
    const u = new URL(url);
    this.ns = `konnect.${keyPart(`${u.host}${u.pathname}`)}`;
  }

  /** Writes one at a time. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private key = () => `${this.ns}.login`;

  async get(): Promise<Login | undefined> {
    const raw = await this.kv.get(this.key());
    if (!raw) return undefined;
    try { return JSON.parse(raw) as Login; } catch { return undefined; }
  }

  async who(): Promise<Who | undefined> {
    const l = await this.get();
    return l && { actor: l.actor, team: l.team, role: l.role };
  }

  put(login: Login): Promise<void> {
    return this.serial(() => this.kv.set(this.key(), JSON.stringify(login)));
  }

  remove(): Promise<void> {
    return this.serial(() => this.kv.remove(this.key()));
  }

  /**
   * The client this phone registered with Kolab, kept across sign-ins (signing out revokes the
   * grant, not the registration), so each sign-in doesn't register another: Kolab limits how many
   * are registered from one place. It is kept with the one redirect it was registered with, and
   * only given for that redirect: Kolab shows a client asking for another an error page, never the
   * app, so one registered for another link (a build before preview had its own) is never used.
   */
  async client(redirect: string): Promise<string | null> {
    const raw = await this.kv.get(`${this.ns}.client`);
    if (!raw) return null;
    try {
      const kept = JSON.parse(raw) as { id?: unknown; redirect?: unknown };
      return kept.redirect === redirect && typeof kept.id === 'string' ? kept.id : null;
    } catch {
      return null; // an earlier build's bare id, for a redirect not known: registered again
    }
  }
  keepClient(id: string, redirect: string): Promise<void> { return this.serial(() => this.kv.set(`${this.ns}.client`, JSON.stringify({ id, redirect }))); }
  forgetClient(): Promise<void> { return this.serial(() => this.kv.remove(`${this.ns}.client`)); }

  /**
   * The per-team sign-ins an earlier build kept (`<ns>.teams`, `<ns>.login.<team>`, `<ns>.current`),
   * taken out of the store: the caller revokes them. Empty once they are gone.
   */
  takeLegacy(): Promise<LegacyLogin[]> {
    return this.serial(async () => {
      const index = await this.kv.get(`${this.ns}.teams`);
      if (index === null) return [];
      let teams: string[] = [];
      try { const v = JSON.parse(index) as unknown; if (Array.isArray(v)) teams = v.filter((t): t is string => typeof t === 'string'); } catch { /* nothing to revoke */ }
      const out: LegacyLogin[] = [];
      for (const team of teams) {
        const raw = await this.kv.get(`${this.ns}.login.${keyPart(team)}`);
        try { if (raw) { const l = JSON.parse(raw) as LegacyLogin; out.push({ team, clientId: l.clientId, refreshToken: l.refreshToken }); } } catch { /* unreadable: just forgotten */ }
        await this.kv.remove(`${this.ns}.login.${keyPart(team)}`);
      }
      await this.kv.remove(`${this.ns}.current`);
      await this.kv.remove(`${this.ns}.teams`);
      return out;
    });
  }
}
