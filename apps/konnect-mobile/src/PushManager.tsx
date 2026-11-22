/**
 * Push for the signed-in teams: after the first sign-in (not at launch), the phone's token is got
 * and registered with each team whose Kolab has push (S4); a notification's tap opens its
 * conversation, in its team. What happened is kept for the Notifications screen to say.
 */
import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useEffect } from 'react';
import { useAuth } from './auth/AuthProvider';
import { kolabHasPush, PUSH_STATUS_KEY, PUSH_TOKEN_KEY, pushToken, registerDevice, routeOf } from './push';

/** Shows a notification that arrives while the app is open, set once, when push first starts. */
let handling = false;
function showWhileOpen() {
  if (handling) return;
  handling = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true }),
  });
}

export function PushManager() {
  const auth = useAuth();
  const qc = useQueryClient();
  const teams = auth.teams.map((t) => t.team).join(',');

  useEffect(() => {
    if (!teams) return;
    showWhileOpen();
    let live = true;
    void (async () => {
      const got = await pushToken().catch((e: Error) => ({ ok: false as const, why: e.message }));
      if (!live) return;
      if (!got.ok) { await Storage.setItem(PUSH_STATUS_KEY, got.why); return; }
      await Storage.setItem(PUSH_TOKEN_KEY, got.token);
      const said: string[] = [];
      for (const team of teams.split(',')) {
        try {
          const client = await auth.client(team);
          if (!(await kolabHasPush(client))) { said.push(`${team}: this Kolab has no push yet`); continue; }
          await registerDevice(client, got.token);
          said.push(`${team}: on`);
        } catch (e) { said.push(`${team}: ${(e as Error).message}`); }
      }
      await Storage.setItem(PUSH_STATUS_KEY, said.join('\n'));
    })();
    return () => { live = false; };
  }, [teams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const open = (data: unknown) => {
      const to = routeOf(data);
      if (!to) return;
      // Push is the person's, from every team: one for another team switches there first.
      void auth.switchTeam(to.team).then(() => router.push(to.path as Href), () => undefined);
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last.notification.request.content.data);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
    // Each push may be another team's: their dots and badges are read again.
    const heard = Notifications.addNotificationReceivedListener?.(() => void qc.invalidateQueries({ queryKey: ['account'] }));
    return () => { sub?.remove?.(); heard?.remove?.(); };
  }, [auth, qc]);
  return null;
}
