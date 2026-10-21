// What a sign-in may reach and open (W3.5 review): Kolab's URL must be https, or http on loopback;
// the browser opens only Kolab's own /oauth/authorize, with no shell; and a hostile Kolab whose
// metadata names another endpoint (file:, another host, `&` in the path) gets nothing opened.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from '@jest/globals';
import { StoredLogin, browserCommand, checkAuthorizeUrl, checkKolabUrl, isLoopback, login, logout, openBrowser, safeUrl } from '../src/index.js';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

test('a sign-in uses https, or http on this machine only', () => {
  for (const ok of ['https://kolab.konjir.com/mcp', 'http://127.0.0.1:7420/mcp', 'http://localhost:7420/mcp', 'http://[::1]:7420/mcp', 'http://127.1.2.3/mcp']) {
    expect(checkKolabUrl(ok).toString()).toBe(new URL(ok).toString());
  }
  expect(isLoopback('127.0.0.1') && isLoopback('[::1]') && isLoopback('LOCALHOST')).toBe(true);
  expect(isLoopback('127.0.0.1.evil.example') || isLoopback('10.0.0.1') || isLoopback('localhost.evil.example')).toBe(false);
  expect(() => checkKolabUrl('http://kolab.konjir.com/mcp')).toThrow(/only over https, or http on this machine: http:\/\/kolab\.konjir\.com\/mcp is http to another host/);
  expect(() => checkKolabUrl('ftp://kolab.konjir.com/mcp')).toThrow(/is ftp/);
  expect(() => checkKolabUrl('not a url')).toThrow(/isn't a URL/);
  // The shared client refuses it too, so the CLI and the bridge both do.
  const path = join(mkdtempSync(join(tmpdir(), 'konjir-urls-')), 'c.json');
  expect(() => new StoredLogin('http://kolab.example/mcp', { path })).toThrow(/http to another host/);
  return expect(login('http://kolab.example/mcp', { path, open: () => { throw new Error('opened'); } })).rejects.toThrow(/http to another host/);
});

test('only what is fit to print is printed of a URL', () => {
  expect(safeUrl('https://ann:secret@kolab.example/mcp?token=kjs_x#frag')).toBe('https://kolab.example/mcp');
  expect(safeUrl('nope')).toBe('(not a URL)');
});

test('the browser opens only Kolab\'s own /oauth/authorize, as fixed arguments with no shell', () => {
  const kolab = 'https://kolab.example/mcp';
  const ran: [string, string[]][] = [];
  const run = (cmd: string, args: string[]) => { ran.push([cmd, args]); };
  for (const hostile of [
    'file:///etc/passwd',
    'https://evil.example/oauth/authorize?x=1',
    'https://kolab.example/a&calc&/x',
    'https://kolab.example/oauth/authorize/../../etc',
    'https://kolab.example:8443/oauth/authorize',
    'http://kolab.example/oauth/authorize',
    'https://ann:pw@kolab.example/oauth/authorize',
    'smb://kolab.example/oauth/authorize',
    'search-ms:query=x',
  ]) {
    expect(() => openBrowser(new URL(hostile), kolab, run)).toThrow(/isn't its own https:\/\/kolab\.example\/oauth\/authorize, so konjir opens nothing/);
  }
  expect(ran).toStrictEqual([]);

  // Kolab's own, with & and quotes in it: one argument, as it is.
  const good = new URL('https://kolab.example/oauth/authorize?client_id=kjcl_1&state=a"b&scope=konjir%20x');
  openBrowser(good, kolab, run);
  expect(ran).toHaveLength(1);
  expect(ran[0][1]).toContain(good.toString());
  expect(browserCommand(good, 'win32')).toStrictEqual(['rundll32', ['url.dll,FileProtocolHandler', good.toString()]]);
  expect(browserCommand(good, 'darwin')).toStrictEqual(['open', [good.toString()]]);
  expect(browserCommand(good, 'linux')).toStrictEqual(['xdg-open', [good.toString()]]);
  expect(checkAuthorizeUrl(new URL('http://127.0.0.1:7420/oauth/authorize?x=1'), 'http://127.0.0.1:7420/mcp').pathname).toBe('/oauth/authorize');
});

/** A hostile "Kolab": an MCP endpoint that asks for sign-in, and authorization metadata naming `endpoint`. */
async function hostileKolab(endpoint: (origin: string) => string) {
  const server = createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const u = new URL(req.url ?? '/', origin);
    if (u.pathname === '/mcp') {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end();
    } else if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    } else if (u.pathname.startsWith('/.well-known/oauth-authorization-server') || u.pathname.startsWith('/.well-known/openid-configuration')) {
      json({ issuer: origin, authorization_endpoint: endpoint(origin), token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'] });
    } else if (u.pathname === '/oauth/register') {
      let body = '';
      req.on('data', (d) => { body += String(d); });
      req.on('end', () => json({ ...JSON.parse(body), client_id: 'kjcl_hostile', client_id_issued_at: Math.floor(Date.now() / 1000) }));
    } else {
      res.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

test('a Kolab whose metadata names another sign-in endpoint gets nothing opened or printed', async () => {
  for (const endpoint of [() => 'file:///etc/passwd', () => 'https://evil.example/oauth/authorize', (o: string) => `${o}/a&calc&/x`]) {
    const url = await hostileKolab(endpoint);
    const path = join(mkdtempSync(join(tmpdir(), 'konjir-hostile-')), 'c.json');
    const opened: URL[] = [];
    const printed: string[] = [];
    await expect(login(url, { path, timeoutMs: 2000, log: (l) => printed.push(l), open: (u) => { opened.push(u); } })).rejects.toThrow(/so konjir opens nothing/);
    expect(opened).toStrictEqual([]);
    expect(printed).toStrictEqual([]);
  }
});

test('between connections a process lets go only of an idle hold, never of a refresh in flight, whose lock keeps another konjir from refreshing with the same token', async () => {
  const URL_ = 'http://127.0.0.1:9/mcp';
  const tokens = (n: number) => ({ access_token: `kjs_a${n}`, refresh_token: `kjr_r${n}`, token_type: 'Bearer', expires_in: 900 });
  const path = join(mkdtempSync(join(tmpdir(), 'konjir-idle-')), 'c.json');
  await new StoredLogin(URL_, { path }).saveTokens(tokens(1));
  const bridge = new StoredLogin(URL_, { path });
  expect((await bridge.tokens({}))?.refresh_token).toBe('kjr_r1');   // a refresh starts: the lock is taken
  bridge.releaseIdleLock();                                          // the bridge's connection ends meanwhile
  expect(statSync(`${path}.lock`).isFile()).toBe(true);
  const cli = new StoredLogin(URL_, { path, lockWaitMs: 300 });
  await expect(cli.tokens({})).rejects.toThrow(/couldn't take/);    // the CLI can't read kjr_r1 to refresh with it
  await bridge.saveTokens(tokens(2));
  expect(() => statSync(`${path}.lock`)).toThrow();
  expect((await cli.tokens({}))?.refresh_token).toBe('kjr_r2');
  await cli.saveTokens(tokens(3));
  bridge.releaseIdleLock();                                          // idle: nothing to let go, nothing broken
  expect(new StoredLogin(URL_, { path }).saved().tokens?.refresh_token).toBe('kjr_r3');
});

test('a sign-in kept for http to another host, from before the https check: logout refuses to send it, and --forget drops it without contacting Kolab', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'konjir-forget-')), 'c.json');
  const remote = 'http://kolab.example/mcp';
  const kept = { client: { client_id: 'kjcl_1' }, tokens: { access_token: 'kjs_a', refresh_token: 'kjr_r', token_type: 'Bearer' } };
  writeFileSync(path, JSON.stringify({ [remote]: kept, 'http://127.0.0.1:9/mcp': kept }));
  await expect(logout(remote, { path })).rejects.toThrow(/http to another host.*To drop the sign-in kept for it without contacting Kolab, run konjir logout --forget/);
  expect(JSON.parse(readFileSync(path, 'utf8'))[remote]).toBeDefined();
  // kolab.example is never resolved, let alone sent the tokens: --forget only reads and drops the entry.
  expect(await logout(remote, { path, forget: true })).toStrictEqual({ had: true, revoked: false, why: 'konjir doesn\'t contact Kolab over http to another host' });
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toStrictEqual(['http://127.0.0.1:9/mcp']);
});
