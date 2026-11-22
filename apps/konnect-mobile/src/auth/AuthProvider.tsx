/**
 * The app's sign-ins, for every screen: the teams signed in to and the one shown, signing in to a
 * team or making one, switching, and signing out. Tokens stay in here (LoginStore, Tokens); screens
 * get a team's MCP client, never a token.
 */
import type { Client } from '@modelcontextprotocol/client';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appExtra } from '@/config';
import { teamClient } from './mcp';
import { discover, signIn as signInWith, type KolabOAuth, type SignInAsk } from './sign-in';
import { LoginStore, type SecureKV, type TeamSummary } from './store';
import { SignedOut, Tokens } from './tokens';

/** expo-secure-store, readable after the phone's first unlock (so a refresh can run in the background later). */
const secureKV: SecureKV = {
  get: (k) => SecureStore.getItemAsync(k, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  set: (k, v) => SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
  remove: (k) => SecureStore.deleteItemAsync(k, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }),
};

export interface Auth {
  ready: boolean;
  url: string;
  teams: TeamSummary[];
  current?: TeamSummary;
  /** Signs in through Kolab's page: picking a team or an invitation, or making `team`. Resolves with the team. */
  signIn(ask: SignInAsk): Promise<string>;
  signOut(team: string): Promise<{ revoked: boolean }>;
  switchTeam(team: string): Promise<void>;
  /** The team's MCP client, connected once and shared. */
  client(team: string): Promise<Client>;
}

const AuthContext = createContext<Auth | null>(null);

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('useAuth needs an AuthProvider');
  return auth;
}

export function AuthProvider({ children, kv = secureKV }: { children: ReactNode; kv?: SecureKV }) {
  const url = appExtra().konnectUrl;
  const scheme = [Constants.expoConfig?.scheme].flat()[0] ?? 'com.konjir.konnect';
  // The team whose sign-in Kolab ended last, with a count so the same team twice is seen twice.
  const [ended, setEnded] = useState<{ team: string; n: number }>();
  const { store, tokens } = useMemo(() => {
    const store = new LoginStore(kv, url);
    let oauth: Promise<KolabOAuth> | undefined;
    const endpoints = () => (oauth ??= discover(url).catch((e) => { oauth = undefined; throw e; }));
    return { store, tokens: new Tokens({ store, endpoints, fetch: (u, init) => fetch(u, init), onSignedOut: (team) => setEnded((e) => ({ team, n: (e?.n ?? 0) + 1 })) }) };
  }, [kv, url]);
  const clients = useRef(new Map<string, Promise<Client>>());
  const [state, setState] = useState<{ ready: boolean; teams: TeamSummary[]; current?: string }>({ ready: false, teams: [] });

  const read = useCallback(async () => ({ ready: true, teams: await store.summaries(), current: await store.current() }), [store]);
  const reload = useCallback(async () => setState(await read()), [read]);
  useEffect(() => {
    let live = true;
    void read().then((s) => { if (live) setState(s); });
    return () => { live = false; };
  }, [read]);

  const dropClient = useCallback((team: string) => {
    const c = clients.current.get(team);
    clients.current.delete(team);
    void c?.then((x) => x.close()).catch(() => undefined);
  }, []);
  // Kolab ended a team's sign-in: its connection goes, and the app shows the teams left (or the sign-in screen).
  useEffect(() => { if (ended) { dropClient(ended.team); void read().then(setState); } }, [ended, dropClient, read]);

  const auth: Auth = {
    ready: state.ready, url, teams: state.teams,
    current: state.teams.find((t) => t.team === state.current),
    signIn: async (ask) => {
      const login = await signInWith({ url, scheme, ask, clientName: `konnect (${appExtra().variant})` });
      const before = await store.get(login.team);
      await store.put(login);
      await store.setCurrent(login.team);
      // The sign-in this one replaces is ended at Kolab, not left to lapse.
      if (before) { dropClient(login.team); void tokens.revoke(before); }
      await reload();
      return login.team;
    },
    signOut: async (team) => {
      dropClient(team);
      const r = await tokens.signOut(team);
      await reload();
      return r;
    },
    switchTeam: async (team) => { await store.setCurrent(team); await reload(); },
    client: (team) => {
      let c = clients.current.get(team);
      if (!c) {
        c = teamClient(url, { token: () => tokens.accessToken(team), renew: (refused) => tokens.renew(team, refused) });
        c.catch((e) => {
          clients.current.delete(team);
          if (e instanceof SignedOut) void reload();
        });
        clients.current.set(team, c);
      }
      return c;
    },
  };
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}
