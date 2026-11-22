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
import { discover, signIn as signInWith, SignInStopped, type KolabOAuth, type SignInAsk } from './sign-in';
import { LoginStore, type SecureKV, type Who } from './store';
import { Tokens } from './tokens';

/** expo-secure-store, readable after the phone's first unlock (so a refresh can run in the background later). */
const secureKV: SecureKV = {
  get: (k) => SecureStore.getItemAsync(k, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  set: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  remove: (k) => SecureStore.deleteItemAsync(k, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
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
  /** The MCP client, connected once and shared; it follows the sign-in from team to team. */
  client(team?: string): Promise<Client>;
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
  const { store, tokens } = useMemo(() => {
    const store = new LoginStore(kv, url);
    let oauth: Promise<KolabOAuth> | undefined;
    const endpoints = () => (oauth ??= discover(url).catch((e) => { oauth = undefined; throw e; }));
    return { store, tokens: new Tokens({ store, endpoints, fetch: (u, init) => fetch(u, init), onSignedOut: () => setEnded((n) => n + 1) }) };
  }, [kv, url]);
  const client = useRef<Promise<Client> | undefined>(undefined);
  const [state, setState] = useState<{ ready: boolean; who?: Who }>({ ready: false });

  const read = useCallback(async () => ({ ready: true, who: await store.who() }), [store]);
  const reload = useCallback(async () => setState(await read()), [read]);
  useEffect(() => {
    let live = true;
    // Sign-ins an earlier build kept per team are revoked and forgotten: one sign-in now.
    void store.takeLegacy().then((old) => { for (const l of old) void tokens.revoke(l); }).catch(() => undefined)
      .then(read).then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [store, tokens, read]);

  const dropClient = useCallback(() => {
    const c = client.current;
    client.current = undefined;
    void c?.then((x) => x.close()).catch(() => undefined);
  }, []);
  useEffect(() => { if (ended) { dropClient(); void read().then(setState); } }, [ended, dropClient, read]);

  const auth: Auth = {
    ready: state.ready, url, adapter,
    current: state.who,
    teams: state.who ? [state.who] : [],
    signIn: async (ask) => {
      const clientName = `konnect (${appExtra().variant})`;
      const kept = await store.client();
      let login;
      try {
        login = await signInWith({ url, scheme, ask, clientName, clientId: kept });
      } catch (e) {
        // A registration Kolab no longer knows (a Kolab started afresh, say): register again, once.
        // Kolab's page can't send an unknown client back, so a sign-in closed on it also forgets
        // the registration, and the next try registers anew.
        if (kept && e instanceof SignInStopped) await store.forgetClient();
        if (!kept || !/client/i.test((e as Error).message)) throw e;
        await store.forgetClient();
        login = await signInWith({ url, scheme, ask, clientName });
      }
      await store.keepClient(login.clientId);
      const before = await store.get();
      await store.put(login);
      dropClient();
      // The sign-in this one replaces is ended at Kolab, not left to lapse.
      if (before) void tokens.revoke(before);
      await reload();
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
    client: () => {
      if (!client.current) {
        const c = teamClient(url, { token: () => tokens.accessToken(), renew: (refused) => tokens.renew(refused) });
        c.catch(() => { if (client.current === c) client.current = undefined; });
        client.current = c;
      }
      return client.current;
    },
  };
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
