// kolab's words for what the server and @konjir/login still say as konjir (words.ts), and what the
// kolab CLI's channel tells Kolab it is at initialize, where konnect's bridges keep their own name.
import { expect, test } from '@jest/globals';
import { createServer, type IncomingMessage } from 'node:http';
import { KolabBridge } from '../src/bridge.js';
import { KOLAB_CLIENT, kolabHints, kolabWords } from '../src/words.js';

test('kolabWords says konjir\'s commands as kolab\'s, and leaves every name a machine reads', () => {
  expect(kolabWords('your sign-in to https://k/mcp has ended or was revoked: run konjir login')).toBe('your sign-in to https://k/mcp has ended or was revoked: run kolab login');
  expect(kolabWords('Kolab didn\'t finish the setup: run konjir connect again')).toBe('Kolab didn\'t finish the setup: run kolab connect again');
  expect(kolabWords('konjir login --kolab test --role engineer, then konjir import again')).toBe('kolab login --kolab test --role engineer, then kolab import again');
  expect(kolabWords('record them as you push: konjir work deliver kj:b#W1 --submit')).toBe('record them as you push: kolab work deliver kj:b#W1 --submit');
  expect(kolabWords('`konjir instructions` gives the same; konjir logout --forget drops it')).toBe('`kolab instructions` gives the same; kolab logout --forget drops it');
  const kept = 'konjir_whoami, konjir://answers/k/a, kj:konjir/x, konjir-product, .konjir.json, ~/.config/konjir/, @konjir/kolab, konjir kolab:k role:product, konjir team:t, konjir CLI, konjir channel (Claude Code), the konjir package, konjir-import/1';
  expect(kolabWords(kept)).toBe(kept);
});

test('kolabHints rewrites only what is under next, at any depth; the kolab\'s own content stays as it is', () => {
  const result = {
    next: 'konjir login --kolab test --role engineer, then konjir import again',
    node: { text: 'The CLI is taken by `konjir work`.', next: ['run konjir work deliver', { why: 'konjir connect' }] },
    items: [{ next: 'konjir watch --once' }, { title: 'konjir login' }],
    count: 3, none: null,
  };
  expect(kolabHints(result)).toStrictEqual({
    next: 'kolab login --kolab test --role engineer, then kolab import again',
    node: { text: 'The CLI is taken by `konjir work`.', next: ['run kolab work deliver', { why: 'kolab connect' }] },
    items: [{ next: 'kolab watch --once' }, { title: 'konjir login' }],
    count: 3, none: null,
  });
  expect(kolabHints('konjir login')).toBe('konjir login');
  expect(result.next).toBe('konjir login --kolab test --role engineer, then konjir import again');
});

type Info = { name: string; version: string };

/** A Kolab stand-in that records the clientInfo each client sends as it connects, and refuses everything. */
async function recorder() {
  const seen: Info[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (d) => { body += d; }).on('end', () => {
      try {
        // initialize's params, or, for 2026-07-28, server/discover's _meta.
        const m = JSON.parse(body) as { params?: { clientInfo?: Info; _meta?: Record<string, unknown> } };
        const info = m.params?.clientInfo ?? m.params?._meta?.['io.modelcontextprotocol/clientInfo'] as Info | undefined;
        if (info) seen.push(info);
      } catch { /* not JSON */ }
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  return { seen, url, close: () => new Promise((r) => server.close(r)) };
}

const until = async (what: string, ok: () => boolean) => {
  for (const end = Date.now() + 10_000; !ok(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

test('the kolab channel says it is kolab as it connects (the opt-in to the server\'s kolab wording); a bridge given nothing, as konnect\'s are, keeps konjir-channel-bridge', async () => {
  expect(KOLAB_CLIENT).toStrictEqual({ name: 'kolab', version: 'development' });
  const r = await recorder();
  try {
    for (const clientInfo of [KOLAB_CLIENT, undefined]) {
      const before = r.seen.length;
      const bridge = new KolabBridge({ url: r.url, token: 'kjs_x', forward: async () => undefined, log: () => undefined, ...(clientInfo ? { clientInfo } : {}) });
      bridge.start();
      await until('a client to say what it is', () => r.seen.length > before);
      await bridge.stop();
    }
    expect(r.seen[0]).toStrictEqual({ name: 'kolab', version: 'development' });
    expect(r.seen.at(-1)!.name).toBe('konjir-channel-bridge');
  } finally {
    await r.close();
  }
});
