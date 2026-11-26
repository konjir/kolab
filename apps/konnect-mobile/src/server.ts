/**
 * The Kolab server konnect talks to: Konjir's own (the build's `konnectUrl`, kolab.konjir.com) unless
 * the person chose another while signed out, such as their team's own Kolab. The choice is no
 * secret, so it is kept in the app's storage, not the secure store; each server has its own sign-in
 * there (LoginStore is keyed by the server's URL), so choosing another never touches the first's.
 */
import Storage from 'expo-sqlite/kv-store';
import { appExtra } from '@/config';

const SERVER_KEY = 'konnect.server';

/** Where to read how to run a Kolab of your own. */
export const RUN_YOUR_OWN_URL = 'https://www.konjir.com/kolab/self-hosting/';

/** Konjir's own Kolab, the build's default. */
export const defaultServer = () => appExtra().konnectUrl;

/** What the person typed isn't a Kolab address the app can use. */
export class BadServer extends Error { name = 'BadServer'; }

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * The MCP URL for what the person typed: `kolab.example.com`, `https://kolab.example.com` or the
 * whole `https://kolab.example.com/mcp`. A Kolab is served at its bare name on https's own port, and
 * issues tokens for `<origin>/mcp` alone, so any other path or port is refused rather than kept for a
 * sign-in that can't work. A development build may reach a Kolab on this machine over http, on any
 * port, as Kolab itself allows on loopback only.
 */
export function serverUrl(typed: string, variant = appExtra().variant): string {
  const t = typed.trim();
  if (!t) throw new BadServer('Enter the address of a Kolab server, such as kolab.example.com.');
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
  } catch {
    throw new BadServer(`"${t}" isn't a web address.`);
  }
  const host = u.hostname;
  const local = u.protocol === 'http:' && variant === 'development' && LOOPBACK.test(host);
  if (u.protocol !== 'https:' && !local) throw new BadServer('The address must start with https://.');
  if (u.username || u.password) throw new BadServer('The address can\'t hold a name or password.');
  if (u.search || u.hash) throw new BadServer('The address can\'t hold a ? or #.');
  if (!local && u.port) throw new BadServer('A Kolab is served on https\'s own port: leave the :port out.');
  if (!local && !host.includes('.') && !host.startsWith('[')) throw new BadServer(`"${host}" isn't a full server name, such as kolab.example.com.`);
  const path = u.pathname.replace(/\/+$/, '');
  if (path && path !== '/mcp') throw new BadServer('Enter the server\'s name alone, such as kolab.example.com: a Kolab is always at /mcp.');
  return `${u.origin}/mcp`;
}

/** The server's name to show: its host, with the path only when it isn't Kolab's usual `/mcp`. */
export function serverName(url: string): string {
  const u = new URL(url);
  return u.pathname === '/mcp' ? u.host : `${u.host}${u.pathname}`;
}

/** The server chosen on this phone, or Konjir's. */
export async function loadServer(): Promise<string> {
  const kept = await Storage.getItem(SERVER_KEY).catch(() => null);
  if (!kept) return defaultServer();
  try { return serverUrl(kept); } catch { return defaultServer(); }
}

/** Keeps the server chosen, or with Konjir's, forgets the choice. */
export async function saveServer(url: string): Promise<void> {
  if (url === defaultServer()) await Storage.removeItem(SERVER_KEY);
  else await Storage.setItem(SERVER_KEY, url);
}
