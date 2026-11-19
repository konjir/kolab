// The kolab CLI says it is kolab as it connects (the opt-in to the server's kolab wording, step 1b
// of docs/plans/rebrand-and-site.md), and says what Kolab and @konjir/login still word for konjir in
// its own words: `run konjir login` reaches the person as `run kolab login`.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import { connect } from '../src/cli.js';

type Info = { name: string; version: string };

test('connect says it is kolab, with this build\'s version (development from a checkout), never konjir-cli', async () => {
  const seen: Info[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; }).on('end', () => {
      try {
        const m = JSON.parse(body) as { params?: { clientInfo?: Info; _meta?: Record<string, unknown> } };
        const info = m.params?.clientInfo ?? m.params?._meta?.['io.modelcontextprotocol/clientInfo'] as Info | undefined;
        if (info) seen.push(info);
      } catch { /* not JSON */ }
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    await expect(connect(url, 'kjs_x')).rejects.toThrow();
    expect(seen.length).toBeGreaterThan(0);
    for (const info of seen) expect(info).toStrictEqual({ name: 'kolab', version: 'development' });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('an error from @konjir/login that says run konjir login is printed saying run kolab login; konjir\'s own names stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kolab-words-'));
  const file = join(dir, 'credentials.json');
  writeFileSync(file, 'not json');
  const env = { ...process.env, KONJIR_CREDENTIALS: file, KONJIR_URL: 'http://127.0.0.1:9/mcp', KONJIR_TOKEN: '' };
  // The CLI as built, as an installed kolab runs: its entry prints the error.
  const r = await new Promise<{ code: number | null; err: string }>((ok) => {
    const p = execFile(process.execPath, [join(import.meta.dirname, '..', 'dist', 'main.js'), 'whoami'], { env, cwd: dir }, (_e, _out, err) => ok({ code: p.exitCode, err }));
  });
  expect(r.code).toBe(1);
  expect(r.err).toContain(`${file} isn't konjir's credentials (not valid JSON), so konjir won't touch it: fix it or move it away, then run kolab login`);
  expect(r.err).not.toMatch(/run konjir login/);
});
