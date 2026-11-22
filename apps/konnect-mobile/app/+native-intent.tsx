import { isAppLinkSignIn } from '@/auth/app-links';

/**
 * Links the system hands the app before expo-router routes them. A dev client opens the app with
 * its own link (`<scheme>://expo-development-client/?url=…`), and Kolab's sign-in answer comes back
 * as `<scheme>:/oauth?…` (development) or as the variant's https link,
 * `https://www.konjir.com/konnect/app{,/preview}/oauth?…` (preview and production), which the auth
 * session takes: none is a screen, so all go home, where the sign-in gate decides what shows.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (isAppLinkSignIn(path)) return '/';
  return /^\/?(expo-development-client|oauth)(\/|\?|$)/.test(path.replace(/^[a-z0-9.+-]+:\/*/i, '')) ? '/' : path;
}
