/**
 * Push for the person: after each sign-in (not at launch), the phone's token is got and registered
 * with Kolab (S4; registering deletes the sign-in's other tokens). A notification's tap opens its
 * conversation, switching team first when it is another team's, once per tap. Each push received
 * re-reads the person's teams, for the switcher's dots. What happened is kept for the Notifications
 * screen to say.
 */
import { useQueryClient } from '@tanstack/react-query';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import Storage from 'expo-sqlite/kv-store';
import { useEffect, useRef } from 'react';
import { useAuth, type Auth } from './auth/AuthProvider';
import { tapHandler, type Tap } from './notification-taps';
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
  const signedIn = !!auth.current;
  // The latest auth, for the tap handler set up once.
  const latest = useRef<Auth>(auth);
  useEffect(() => { latest.current = auth; });

  // After each sign-in: the token, registered.
  useEffect(() => {
    if (!signedIn) return;
    showWhileOpen();
    let live = true;
    void (async () => {
      const got = await pushToken().catch((e: Error) => ({ ok: false as const, why: e.message }));
      if (!live) return;
      if (!got.ok) { await Storage.setItem(PUSH_STATUS_KEY, got.why); return; }
      await Storage.setItem(PUSH_TOKEN_KEY, got.token);
      let said: string;
      try {
        const client = await latest.current.client();
        if (!(await kolabHasPush(client))) said = 'This Kolab has no push yet.';
        else { await registerDevice(client, got.token); said = 'On.'; }
      } catch (e) { said = (e as Error).message; }
      await Storage.setItem(PUSH_STATUS_KEY, said);
    })();
    return () => { live = false; };
  }, [signedIn, auth.signIns]);

  // Taps, each once; the one that launched the app, then cleared so it never opens again.
  useEffect(() => {
    const handle = tapHandler((data) => {
      const to = routeOf(data);
      if (!to) return;
      // Push is the person's, from every team: one for another team switches there first, and the
      // switch resets the screens (the root layout), so the conversation opens after it.
      void latest.current.switchTeam(to.team).then(() => setTimeout(() => router.push(to.path as Href), 50), () => undefined);
    });
    if (handle(Notifications.getLastNotificationResponse?.() as Tap | null)) void Notifications.clearLastNotificationResponseAsync?.().catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      if (handle(r as unknown as Tap)) void Notifications.clearLastNotificationResponseAsync?.().catch(() => undefined);
    });
    // Each push may be another team's: their dots and badges are read again.
    const heard = Notifications.addNotificationReceivedListener?.(() => void qc.invalidateQueries({ queryKey: ['account'] }));
    return () => { sub?.remove?.(); heard?.remove?.(); };
  }, [qc]);
  return null;
}
