/**
 * Links the system hands the app before expo-router routes them. A dev client opens the app with
 * its own link (`<scheme>://expo-development-client/?url=…`), and Kolab's sign-in answer comes back
 * as `<scheme>:/oauth?…` (which the auth session takes): neither is a screen, so both go home, where
 * the sign-in gate decides what shows.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return /^\/?(expo-development-client|oauth)(\/|\?|$)/.test(path.replace(/^[a-z0-9.+-]+:\/*/i, '')) ? '/' : path;
}
