// konjir.com's CloudFront Function (deploy/terraform/modules/site/www-redirect.js.tftpl, D81):
// www.konjir.com is canonical by the pages' canonical links, but the apex serves the same pages and
// doesn't redirect, since browsers may hold the old function's uncached www-to-apex 301 forever.
// On both hosts the pages that moved when the site was split by product (/hands-on/, /messages/)
// answer with a 301 to where they are now on www, and a folder's page is its index.html. Every 301
// may be cached a day. CloudFront's own runtime isn't available here, so this runs the function's
// code as Terraform renders it against events shaped like CloudFront's.
import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const template = readFileSync(resolve(import.meta.dirname, '../../../deploy/terraform/modules/site/www-redirect.js.tftpl'), 'utf8');
const code = template.replaceAll('${www}', 'www.konjir.com').replaceAll('${apex}', 'konjir.com');
type Request = { uri: string; headers: Record<string, { value: string }>; querystring: Record<string, unknown>; rawQueryString?: () => string };
type Response = { statusCode: number; headers: { location: { value: string } } };
const handler = runInNewContext(`${code}\nhandler`) as (event: { request: Request }) => Request | Response;

const request = (host: string | undefined, uri: string, raw: string): Request => ({
  uri,
  headers: host === undefined ? {} : { host: { value: host } },
  querystring: {},
  rawQueryString: () => raw,
});
const moved = (location: string) => ({
  statusCode: 301,
  statusDescription: 'Moved Permanently',
  headers: { location: { value: location }, 'cache-control': { value: 'public, max-age=86400' } },
});
const HOSTS = ['www.konjir.com', 'konjir.com'];

test('the template has nothing left for Terraform to fill', () => {
  expect(code).not.toMatch(/\$\{/);
});

test('both hosts, other hosts and a missing host pass a file through as it came', () => {
  for (const host of [...HOSTS, 'WWW.Konjir.COM', 'kolab.konjir.com', 'konjir.com.evil.example', 'evilkonjir.com', undefined]) {
    for (const uri of ['/', '/index.html', '/assets/site.0123456789.css', '/robots.txt', '/sitemap.xml', '/og/www.jpg', '/kolab/index.html']) {
      const r = request(host, uri, 'q=1');
      expect(handler({ request: r })).toBe(r);
      expect(r.uri).toBe(uri);
    }
  }
});

test("on both hosts a folder's page is its index.html: /kolab/ is served from /kolab/index.html, and /kolab redirects there", () => {
  for (const host of HOSTS) {
    for (const uri of ['/kolab/', '/kolab/hands-on/', '/konnect/', '/konnect/guide/']) {
      const r = request(host, uri, '');
      expect(handler({ request: r })).toBe(r);
      expect(r.uri).toBe(`${uri}index.html`);
    }
    expect(handler({ request: request(host, '/kolab', 'a=1&b=%26') })).toStrictEqual(moved('/kolab/?a=1&b=%26'));
    expect(handler({ request: request(host, '/konnect/guide', '') })).toStrictEqual(moved('/konnect/guide/'));
  }
});

test("the old pages answer with a 301 to where they are now on www, below them and query kept, in one hop: relative on www, absolute from the apex", () => {
  const cases: [string, string][] = [
    ['/hands-on', '/kolab/hands-on/'],
    ['/hands-on/', '/kolab/hands-on/'],
    ['/hands-on/index.html', '/kolab/hands-on/index.html'],
    ['/messages', '/konnect/guide/'],
    ['/messages/', '/konnect/guide/'],
    ['/messages/index.html', '/konnect/guide/index.html'],
  ];
  for (const [from, to] of cases) {
    expect(handler({ request: request('www.konjir.com', from, '') })).toStrictEqual(moved(to));
    expect(handler({ request: request('www.konjir.com', from, 'utm_source=npm&x=%2F') })).toStrictEqual(moved(`${to}?utm_source=npm&x=%2F`));
    expect(handler({ request: request('konjir.com', from, '') })).toStrictEqual(moved(`https://www.konjir.com${to}`));
    expect(handler({ request: request('Konjir.COM', from, 'a=1') })).toStrictEqual(moved(`https://www.konjir.com${to}?a=1`));
  }
});

test('only those folders moved: a path that merely starts with their name is a folder of its own', () => {
  for (const host of HOSTS) {
    expect(handler({ request: request(host, '/hands-onx', '') })).toStrictEqual(moved('/hands-onx/'));
    expect(handler({ request: request(host, '/messages.txt', '') })).toMatchObject({ uri: '/messages.txt' });
    expect(handler({ request: request(host, '/kolab/hands-on/messages/', '') })).toMatchObject({ uri: '/kolab/hands-on/messages/index.html' });
    expect(handler({ request: request(host, '/messagesx/', '') })).toMatchObject({ uri: '/messagesx/index.html' });
  }
});

// Until this split the function answered www with a 301 to the apex, with no Cache-Control, so a
// browser may still hold it: for that browser, www.konjir.com<path> always goes to konjir.com<path>
// without asking. Following that cached redirect and then the new function must never cycle.
test('a browser holding the old www-to-apex 301 never loops: every URL that existed lands on a page', () => {
  const cachedOld = (url: URL) => (url.host === 'www.konjir.com' ? new URL(`https://konjir.com${url.pathname}${url.search}`) : null);
  for (const start of ['/', '/hands-on', '/hands-on/', '/messages', '/messages/', '/index.html', '/hands-on/index.html', '/robots.txt', '/kolab/', '/konnect/guide/']) {
    for (const host of HOSTS) {
      let url = new URL(`https://${host}${start}?a=1`);
      const seen = new Set<string>();
      let served: Request | null = null;
      for (let hops = 0; hops < 10 && !served; hops++) {
        expect(seen.has(url.href)).toBe(false);
        seen.add(url.href);
        const old = cachedOld(url);
        if (old) {
          url = old;
          continue;
        }
        const r = request(url.host, url.pathname, url.search.slice(1));
        const res = handler({ request: r });
        if ('statusCode' in res) url = new URL(res.headers.location.value, url);
        else served = res;
      }
      expect(served).not.toBeNull();
      expect(seen.size).toBeLessThanOrEqual(4);
      if (start.startsWith('/hands-on')) expect(served!.uri.startsWith('/kolab/hands-on/')).toBe(true);
      if (start.startsWith('/messages')) expect(served!.uri.startsWith('/konnect/guide/')).toBe(true);
    }
  }
});

test('a redirect for the "/" stays on this host: a path starting "//", or holding "\\", passes through unchanged, to be a 404', () => {
  for (const host of HOSTS) {
    for (const uri of ['//evil.example', '/\\evil.example', '/\\evil.example/', '/a\\b', '/a/\\/', '/hands-on/\\evil.example', '/messages\\x']) {
      const r = request(host, uri, '');
      expect(handler({ request: r })).toBe(r);
      expect(r.uri).toBe(uri);
    }
  }
});

test('a redirect from the apex always names the fixed www host, whatever the path holds', () => {
  const res = handler({ request: request('konjir.com', '/hands-on//evil.example', '') }) as Response;
  expect(res.headers.location.value).toBe('https://www.konjir.com/kolab/hands-on//evil.example');
  expect(new URL(res.headers.location.value).host).toBe('www.konjir.com');
});

test('without rawQueryString() the redirect drops the query rather than failing', () => {
  const r = request('konjir.com', '/messages/', 'a=1');
  delete r.rawQueryString;
  expect(handler({ request: r })).toStrictEqual(moved('https://www.konjir.com/konnect/guide/'));
  const folder = request('www.konjir.com', '/kolab', 'a=1');
  delete folder.rawQueryString;
  expect(handler({ request: folder })).toStrictEqual(moved('/kolab/'));
});
