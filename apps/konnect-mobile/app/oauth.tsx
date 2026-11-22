import { Redirect } from 'expo-router';

/**
 * Where Kolab sends a sign-in back to (`<scheme>:/oauth`). The auth session takes that answer
 * itself; if the system also hands the link to the app (Android can), it lands back on You.
 */
export default function OAuthReturn() {
  return <Redirect href="/you" />;
}
