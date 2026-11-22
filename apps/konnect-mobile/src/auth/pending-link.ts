/**
 * Where a link was taking the person while they were signed out, so sign-in can continue there:
 * the app's own deep links (`<scheme>://c/…`), never Kolab's sign-in answer (`<scheme>:/oauth`) or
 * a dev client's own links.
 */
import * as Linking from 'expo-linking';

let pending: string | undefined;

/** The path of `url`, if it is somewhere in the app worth going back to after sign-in. */
export function pathOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let path: string | null;
  try { path = Linking.parse(url).path; } catch { return undefined; }
  if (!path || /^(oauth|sign-in|expo-development-client|--)(\/|$)/.test(path)) return undefined;
  return `/${path.replace(/^\/+/, '')}`;
}

export function remember(url: string | null | undefined) {
  const p = pathOf(url);
  if (p) pending = p;
}

/** The path to go on to after sign-in, once. */
export function takePending(): string | undefined {
  const p = pending;
  pending = undefined;
  return p;
}
