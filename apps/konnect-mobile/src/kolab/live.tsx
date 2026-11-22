/**
 * The server cache and live updates.
 *
 * - TanStack Query holds what Kolab said, per team: query keys start with the team's name.
 * - The cache is kept on the phone (expo-sqlite's kv-store), so the last of everything shows at once
 *   and offline; what comes from Kolab replaces it.
 * - While the app is in the foreground, each signed-in team has one `subscriptions/listen` stream on
 *   the person's answers resource. Each `notifications/resources/updated` invalidates that team's
 *   queries, which re-read. A stream ends when its access token does (15 minutes) or Kolab restarts:
 *   it is opened again, after a refresh if need be, with backoff. In the background the streams
 *   close; coming back opens them and re-reads everything (push covers the time between, phase 4).
 */
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useAuth, type Auth } from '@/auth/AuthProvider';
import { SignedOut, TeamChanged } from '@/auth/tokens';
import { kolab } from './api';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, gcTime: 7 * 24 * 60 * 60_000, retry: 1, networkMode: 'offlineFirst' } },
});

/**
 * The cache on the phone, one per person (their messages among it, for up to 7 days). It is
 * cleared, in memory and on the phone, when the person signs out or Kolab ends the sign-in.
 *
 * The persister writes at most every `throttleMs`, so a write can still be waiting when the person
 * signs out. `retire` ends it: no write of this persister lands after, even one already on its way,
 * and then the cache is removed.
 */
export function persisterFor(actor: string, throttleMs = 2_000) {
  let retired = false;
  let writing: Promise<unknown> = Promise.resolve();
  const storage = {
    getItem: (k: string) => Storage.getItem(k),
    setItem: async (k: string, v: string) => {
      if (retired) return;
      const w = Storage.setItem(k, v);
      writing = w.catch(() => undefined);
      await w;
    },
    removeItem: (k: string) => Storage.removeItem(k),
  };
  const persister = createAsyncStoragePersister({ storage, key: `konnect.query-cache.${actor}`, throttleTime: throttleMs });
  return {
    persister,
    retire: async () => {
      retired = true;
      await writing;
      await persister.removeClient();
    },
  };
}

export function KolabCache({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const actor = auth.current?.actor ?? '';
  const cache = useMemo(() => persisterFor(actor || 'nobody'), [actor]);
  // The person's persister before this one, kept so that the one that wrote their cache is the one retired.
  const was = useRef({ actor, cache });
  useEffect(() => {
    const before = was.current;
    if (before.actor && before.actor !== actor) {
      queryClient.clear();
      void before.cache.retire().catch(() => undefined);
    }
    was.current = { actor, cache };
  }, [actor, cache]);
  return (
    <PersistQueryClientProvider key={actor || 'nobody'} client={queryClient} persistOptions={{ persister: cache.persister, maxAge: 7 * 24 * 60 * 60_000, buster: 'v1' }}>
      <LiveStreams />
      {children}
    </PersistQueryClientProvider>
  );
}

/** Holds one listen stream per signed-in team while the app is active. */
function LiveStreams() {
  const auth = useAuth();
  const qc = useQueryClient();
  const teams = auth.teams.map((t) => t.team).join(',');
  // What a team signed out of left in the cache (and on the phone) goes with it.
  useEffect(() => {
    if (!auth.ready) return;
    const signedIn = new Set(teams ? teams.split(',') : []);
    qc.removeQueries({ predicate: (q) => !signedIn.has(String(q.queryKey[0])) });
  }, [auth.ready, teams, qc]);
  useEffect(() => {
    if (!teams) return;
    const stops = teams.split(',').map((team) => listen(auth, team, () => void qc.invalidateQueries({ queryKey: [team] })));
    return () => stops.forEach((stop) => stop());
    // auth is the same provider throughout; the teams decide what to hold.
  }, [teams, qc]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Keeps a listen stream open for `team` while the app is active; `onUpdate` on each update. Returns what stops it. */
export function listen(auth: Auth, team: string, onUpdate: () => void): () => void {
  let stopped = false;
  let close: (() => Promise<void>) | undefined;
  let delay = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = async () => {
    if (stopped || AppState.currentState !== 'active' || close) return;
    try {
      const gone = () => stopped || AppState.currentState !== 'active';
      const client = await auth.client(team);
      if (gone()) return;
      const me = await kolab(client).whoami();
      if (gone()) return;
      client.setNotificationHandler('notifications/resources/updated', () => onUpdate());
      const sub = await client.listen({ resourceSubscriptions: me.subscribe });
      if (gone()) { void sub.close().catch(() => undefined); return; }
      close = () => sub.close().catch(() => undefined);
      delay = 1_000;
      onUpdate(); // Catch up on what changed while there was no stream.
      void sub.closed.then(() => { close = undefined; schedule(); });
    } catch (e) {
      close = undefined;
      // Signed out, or the sign-in moved to another team: this team's stream is over.
      if (e instanceof SignedOut || e instanceof TeamChanged) return;
      schedule();
    }
  };
  const schedule = () => {
    if (stopped || AppState.currentState !== 'active') return;
    clearTimeout(timer);
    timer = setTimeout(() => void open(), delay);
    delay = Math.min(delay * 2, 60_000);
  };
  const appState = AppState.addEventListener('change', (s) => {
    if (s === 'active') { delay = 1_000; void open(); } else { void close?.(); close = undefined; clearTimeout(timer); }
  });
  void open();
  return () => { stopped = true; clearTimeout(timer); appState.remove(); void close?.(); };
}
