/**
 * The app's sign-in, for every screen: the person signs in once, with GitHub, and moves between the
 * teams their account belongs to. Who they are and the team they are in, signing in (or accepting an
 * invitation, or making a team, all through Kolab's page), switching teams, and signing out. Tokens
 * stay in here (LoginStore, Tokens); screens get the MCP client, never a token.
 */
import type { Client } from '@modelcontextprotocol/client';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import Storage from 'expo-sqlite/kv-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appExtra } from '@/config';
import { kolabTeams, type TeamsAdapter } from '@/kolab/teams';
import { PUSH_TOKEN_KEY, unregisterDevice } from '@/push';
import { teamClient } from './mcp';
import { discover, InvalidClient, redirectFor, signIn as signInWith, type KolabOAuth, type SignInAsk } from './sign-in';
import { LoginStore, type SecureKV, type Who } from './store';
import { TeamChanged, Tokens } from './tokens';

/**
 * expo-secure-store, readable after the phone's first unlock (so a refresh can run in the
 * background later), and on this device only: never in a backup, never restored to another phone.
 */
const ACCESS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const secureKV: SecureKV = {
  get: (k) => SecureStore.getItemAsync(k, ACCESS),
  set: (k, v) => SecureStore.setItemAsync(k, v, ACCESS),
  remove: (k) => SecureStore.deleteItemAsync(k, ACCESS),
};

export interface Auth {
  ready: boolean;
  url: string;
  /** Who is signed in, and the team the app shows; nothing while signed out. */
  current?: Who;
  /** The signed-in team, as a list (empty while signed out). */
  teams: Who[];
  adapter: TeamsAdapter;
  /** Signs in through Kolab's page: a team or an invitation to pick, or `team` to make. Resolves with the team. */
  signIn(ask: SignInAsk): Promise<string>;
  /** Signs this phone out: the sign-in is revoked at Kolab and forgotten. */
  signOut(): Promise<{ revoked: boolean }>;
  /** Moves the sign-in to another of the person's teams. */
  switchTeam(team: string): Promise<void>;
  /**
   * The MCP client for the team the sign-in is in now, connected once and shared; a new one for each
   * team. With `team`, only for that team: TeamChanged if the sign-in has moved on.
   */
  client(team?: string): Promise<Client>;
  /** A sign-in Kolab moved because the person lost the team (removed, left, archived, erased). */
  moved?: { from: string; to?: string };
  clearMoved(): void;
  /** Counts sign-ins on this phone, so what follows one (registering for push) runs again after each. */
  signIns: number;
}

const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth needs an AuthProvider');
  return auth;
}

export function AuthProvider({ children, kv = secureKV, adapter = kolabTeams }: { children: ReactNode; kv?: SecureKV; adapter?: TeamsAdapter }) {
  const url = appExtra().konnectUrl;
  const scheme = [Constants.expoConfig?.scheme].flat()[0] ?? 'com.konjir.konnect';
  // Kolab ended the sign-in: a count, so the same thing twice is seen twice.
  const [ended, setEnded] = useState(0);
  const [moved, setMoved] = useState<{ from: string; to?: string }>();
  const [signIns, setSignIns] = useState(0);
  const { store, tokens } = useMemo(() => {
    const store = new LoginStore(kv, url);
    let oauth: Promise<KolabOAuth> | undefined;
    const endpoints = () => (oauth ??= discover(url).catch((e) => { oauth = undefined; throw e; }));
    return { store, tokens: new Tokens({ store, endpoints, fetch: (u, init) => fetch(u, init), onSignedOut: () => setEnded((n) => n + 1), onTeamMoved: (from, to) => setMoved({ from, to }) }) };
  }, [kv, url]);
  // One MCP client per team: its token source is bound to that team, so a request in flight when
  // the sign-in moves never reaches the new team (Tokens' TeamChanged).
  const client = useRef<{ team: string; client: Promise<Client> } | undefined>(undefined);
  const [state, setShown] = useState<{ ready: boolean; who?: Who }>({ ready: false });
  // The team the sign-in is in now, for a caller holding an `auth` from an earlier render (a timer,
  // a request that outlived its screen): client() compares with this, never with that render's team.
  const latestTeam = useRef<string | undefined>(undefined);
  const setState = useCallback((s: { ready: boolean; who?: Who }) => { latestTeam.current = s.who?.team; setShown(s); }, []);

  const read = useCallback(async () => ({ ready: true, who: await store.who() }), [store]);
  const reload = useCallback(async () => setState(await read()), [read, setState]);
  useEffect(() => {
    let live = true;
    // Sign-ins an earlier build kept per team are revoked and forgotten: one sign-in now.
    void store.takeLegacy().then((old) => { for (const l of old) void tokens.revoke(l); }).catch(() => undefined)
      .then(read).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [store, tokens, read, setState]);

  const dropClient = useCallback(() => {
    const c = client.current;
    client.current = undefined;
    void c?.client.then((x) => x.close()).catch(() => undefined);
  }, []);
  useEffect(() => { if (ended) { dropClient(); void read().then(setState); } }, [ended, dropClient, read, setState]);
  // Kolab moved the sign-in (the team was lost): a new client for the new team, and the team shown.
  useEffect(() => { if (moved) { dropClient(); void read().then(setState); } }, [moved, dropClient, read, setState]);

  const auth: Auth = {
    ready: state.ready, url, adapter, moved, signIns,
    clearMoved: () => setMoved(undefined),
    current: state.who,
    teams: state.who ? [state.who] : [],
    signIn: async (ask) => {
      const clientName = `konnect (${appExtra().variant})`;
      // A registration Kolab no longer knows is forgotten before Kolab's page opens (signIn asks),
      // and a new one is kept before it opens, so closing the page keeps it.
      const variant = appExtra().variant;
      const redirect = redirectFor(variant, scheme);
      const opts = { url, scheme, variant, ask, clientName, onClientGone: () => store.forgetClient(), onRegistered: (id: string) => store.keepClient(id, redirect) };
      const kept = await store.client(redirect);
      let login;
      try {
        login = await signInWith({ ...opts, clientId: kept });
      } catch (e) {
        // Kolab refused the registration all the same (invalid_client): register again, once.
        // Cancelling the sheet, or any other failure, keeps the registration.
        if (!kept || !(e instanceof InvalidClient)) throw e;
        await store.forgetClient();
        login = await signInWith(opts);
      }
      await store.keepClient(login.clientId, redirect);
      // The sign-in this one replaces is ended at Kolab, not left to lapse; nothing refreshes meanwhile.
      await tokens.replace(login);
      dropClient();
      await reload();
      setSignIns((n) => n + 1);
      return login.team;
    },
    signOut: async () => {
      // The phone stops hearing from Kolab before its sign-in ends (S4; a Kolab without push refuses, and that's fine).
      const token = await Storage.getItem(PUSH_TOKEN_KEY).catch(() => null);
      if (token && state.who) await auth.client().then((c) => unregisterDevice(c, token)).catch(() => undefined);
      dropClient();
      const r = await tokens.signOut();
      await reload();
      return r;
    },
    switchTeam: async (team) => {
      if (!state.who || team === state.who.team) return;
      await tokens.switchTeam(team, async (accessToken) => {
        const c = await teamClient(url, { token: async () => accessToken, renew: async () => accessToken });
        try { return await adapter.switchTo(c, team); } finally { await c.close().catch(() => undefined); }
      });
      dropClient();
      await reload();
    },
    client: (asked) => {
      // Always the team the sign-in is in now. A caller that asks for another (it started before a
      // switch) gets TeamChanged, and the client in use is left alone.
      const team = latestTeam.current ?? '';
      if (asked !== undefined && asked !== team) return Promise.reject(new TeamChanged(`asked for ${asked}, but the sign-in is in ${team || 'no team'}`));
      if (!client.current || client.current.team !== team) {
        dropClient();
        const c = teamClient(url, { token: () => tokens.accessToken(team), renew: (refused) => tokens.renew(refused, team) });
        const entry = { team, client: c };
        c.catch(() => { if (client.current === entry) client.current = undefined; });
        client.current = entry;
      }
      return client.current.client;
    },
  };
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
