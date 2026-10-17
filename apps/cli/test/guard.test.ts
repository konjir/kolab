// The DNS-rebinding guard on /mcp: a page that rebinds a name to 127.0.0.1 must not reach Kolab,
// whatever Host or forwarding headers it sends. Locally Kolab answers loopback host names on any
// port; behind the TLS proxy, its public host name. Foreign browser origins are refused.
import { expect, test } from '@jest/globals';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { startServer } from '@konjir/server';
import { closeAtEnd, testStore } from '@konjir/engine/testing';

const ADMIN = 'guard-admin';
const PUBLIC = 'kolab.example.com';

/** POST tools/list to the server on `port`, with these headers; resolves to the status code. */
function post(port: number, headers: Record<string, string>) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  return new Promise<number>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${ADMIN}`, 'content-length': Buffer.byteLength(body), ...headers,
      },
    }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject);
    req.end(body);
  });
}

/** A port nothing is listening on. */
function freePort() {
  return new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function boot(publicHost?: string) {
  const port = await freePort();
  closeAtEnd(await startServer({ adminToken: ADMIN, port, publicHost, ...(await testStore()) }));
  return port;
}

test('locally, only loopback host names are served, on any port and whatever forwarding headers say', async () => {
  const port = await boot();
  expect(await post(port, {})).toBe(200);
  expect(await post(port, { host: 'localhost:1234' })).toBe(200);
  expect(await post(port, { host: `evil.example:${port}` })).toBe(403);
  expect(await post(port, { host: `evil.example:${port}`, 'x-forwarded-for': '1.2.3.4' })).toBe(403);
  expect(await post(port, { host: `evil.example:${port}`, 'x-forwarded-host': `localhost:${port}` })).toBe(403);
  expect(await post(port, { origin: 'http://evil.example' })).toBe(403);
});

test('behind the proxy, the public host name and loopback are served, and only our own origin', async () => {
  const port = await boot(PUBLIC);
  expect(await post(port, { host: PUBLIC, 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' })).toBe(200);
  expect(await post(port, { host: PUBLIC, 'x-forwarded-for': '1.2.3.4', origin: `https://${PUBLIC}` })).toBe(200);
  expect(await post(port, { host: `127.0.0.1:${port}` })).toBe(200);
  expect(await post(port, { host: 'evil.example', 'x-forwarded-for': '1.2.3.4' })).toBe(403);
  expect(await post(port, { host: PUBLIC, 'x-forwarded-for': '1.2.3.4', origin: 'https://evil.example' })).toBe(403);
});
