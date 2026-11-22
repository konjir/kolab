// konjir.com's CloudFront Function (deploy/terraform/modules/site/www-redirect.js.tftpl, D81):
// www.konjir.com is the site's host, and konjir.com redirects every request there (Lee, 2026-11-20),
// path and query kept, a page that moved straight to where it is now. On www the pages that moved
// when the site was split by product (/hands-on/, /messages/) answer with a 301 to where they are
// now, and a folder's page is its index.html. Every 301 may be cached a day. CloudFront's own
// runtime isn't available here, so this runs the function's code as Terraform renders it against
// events shaped like CloudFront's.
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
const toWww = (path: string, raw = '') => moved(`https://www.konjir.com${path}${raw ? `?${raw}` : ''}`);
const HOSTS = ['www.konjir.com', 'konjir.com'];

test('the template has nothing left for Terraform to fill', () => {
  expect(code).not.toMatch(/\$\{/);
});

test('www, other hosts and a missing host pass a file through as it came', () => {
  for (const host of ['www.konjir.com', 'WWW.Konjir.COM', 'kolab.konjir.com', 'konjir.com.evil.example', 'evilkonjir.com', 'konjir.com:443', undefined]) {
    for (const uri of ['/', '/index.html', '/assets/site.0123456789.css', '/robots.txt', '/sitemap.xml', '/og/www.jpg', '/kolab/index.html']) {
      const r = request(host, uri, 'q=1');
      expect(handler({ request: r })).toBe(r);
      expect(r.uri).toBe(uri);
    }
  }
});

test('the apex answers every request with a 301 to the same path on www, query kept as sent', () => {
  for (const host of ['konjir.com', 'Konjir.COM']) {
    for (const uri of ['/', '/index.html', '/assets/site.0123456789.css', '/robots.txt', '/sitemap.xml', '/og/www.jpg', '/404.html', '/no/such/page', '/kolab', '/kolab/', '/kolab/index.html', '/kolab/hands-on/', '/kolab/how-it-works/', '/konnect/', '/konnect/guide/']) {
      expect(handler({ request: request(host, uri, '') })).toStrictEqual(toWww(uri));
      expect(handler({ request: request(host, uri, 'utm_source=npm&b=%26&c=%2F') })).toStrictEqual(toWww(uri, 'utm_source=npm&b=%26&c=%2F'));
    }
  }
});

test("on www a folder's page is its index.html: /kolab/ is served from /kolab/index.html, and /kolab redirects there", () => {
  for (const uri of ['/kolab/', '/kolab/hands-on/', '/konnect/', '/konnect/guide/']) {
    const r = request('www.konjir.com', uri, '');
    expect(handler({ request: r })).toBe(r);
    expect(r.uri).toBe(`${uri}index.html`);
  }
  expect(handler({ request: request('www.konjir.com', '/kolab', 'a=1&b=%26') })).toStrictEqual(moved('/kolab/?a=1&b=%26'));
  expect(handler({ request: request('www.konjir.com', '/konnect/guide', '') })).toStrictEqual(moved('/konnect/guide/'));
});

test('the old pages answer with a 301 to where they are now on www, below them and query kept, in one hop: relative on www, absolute from the apex', () => {
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
    expect(handler({ request: request('konjir.com', from, '') })).toStrictEqual(toWww(to));
    expect(handler({ request: request('Konjir.COM', from, 'a=1') })).toStrictEqual(toWww(to, 'a=1'));
  }
});

test('only those folders moved: a path that merely starts with their name is a folder of its own', () => {
  expect(handler({ request: request('www.konjir.com', '/hands-onx', '') })).toStrictEqual(moved('/hands-onx/'));
  expect(handler({ request: request('www.konjir.com', '/messages.txt', '') })).toMatchObject({ uri: '/messages.txt' });
  expect(handler({ request: request('www.konjir.com', '/kolab/hands-on/messages/', '') })).toMatchObject({ uri: '/kolab/hands-on/messages/index.html' });
  expect(handler({ request: request('www.konjir.com', '/messagesx/', '') })).toMatchObject({ uri: '/messagesx/index.html' });
  for (const uri of ['/hands-onx', '/messages.txt', '/kolab/hands-on/messages/', '/messagesx/']) {
    expect(handler({ request: request('konjir.com', uri, '') })).toStrictEqual(toWww(uri));
  }
});

// Follows redirects as a browser does, from `start`, with `cached` standing for the 301s the
// browser holds: the URLs visited, and the request served, or the URL it came back to (a loop).
const follow = (start: string, cached: (url: URL) => URL | null) => {
  let url = new URL(start);
  const seen: string[] = [];
  for (let hops = 0; hops < 10; hops++) {
    if (seen.includes(url.href)) return { seen, served: null, loopsAt: url.href };
    seen.push(url.href);
    const hit = cached(url);
    if (hit) {
      url = hit;
      continue;
    }
    const res = handler({ request: request(url.host, url.pathname, url.search.slice(1)) });
    if ('statusCode' in res) url = new URL(res.headers.location.value, url);
    else return { seen, served: res, loopsAt: null };
  }
  throw new Error(`no end to the redirects from ${start}`);
};

test('a browser with no old cached redirect lands on www within 2 redirects, from any URL on either host, query kept', () => {
  for (const host of HOSTS) {
    for (const path of ['/', '/index.html', '/robots.txt', '/kolab', '/kolab/', '/konnect/guide', '/hands-on', '/hands-on/', '/messages', '/messages/index.html']) {
      const { seen, served } = follow(`https://${host}${path}?a=1`, () => null);
      expect(served).not.toBeNull();
      const last = new URL(seen.at(-1)!);
      expect(last.host).toBe('www.konjir.com');
      expect(last.search).toBe('?a=1');
      expect(seen.length - 1).toBeLessThanOrEqual(2);
      if (path.startsWith('/hands-on')) expect(served!.uri.startsWith('/kolab/hands-on/')).toBe(true);
      if (path.startsWith('/messages')) expect(served!.uri.startsWith('/konnect/guide/')).toBe(true);
    }
  }
});

// Known consequence, accepted by Lee on 2026-11-20 when konjir.com began redirecting to www. Until
// 2026-11-19 the function answered every www URL with a 301 to the same URL on the apex, with no
// Cache-Control, so a browser may hold it, for good, for any www URL it visited then. For that
// browser such a URL whose page didn't move, www.konjir.com/ above all, now loops (www -> its
// cached 301 -> apex -> our 301 -> www -> ...) until the entry leaves its cache; clearing the cached
// data for konjir.com and www.konjir.com fixes it. The moved pages, and every URL that never existed
// on www before (/kolab/, /konnect/guide/, ...), still end on their page in at most 2 redirects.
test('a browser holding the old uncached www-to-apex 301 loops on a page that did not move, by design, and on no other URL', () => {
  const OLD = ['/', '/index.html', '/robots.txt', '/hands-on', '/hands-on/', '/hands-on/index.html', '/messages', '/messages/', '/messages/index.html'];
  const cachedOld = (url: URL) => (url.host === 'www.konjir.com' && OLD.includes(url.pathname) ? new URL(`https://konjir.com${url.pathname}${url.search}`) : null);
  for (const host of HOSTS) {
    for (const path of ['/', '/index.html', '/robots.txt']) {
      const { seen, served, loopsAt } = follow(`https://${host}${path}?a=1`, cachedOld);
      expect(served).toBeNull();
      expect(loopsAt).toBe(`https://${host}${path}?a=1`);
      expect(seen).toHaveLength(2);
    }
    for (const path of ['/hands-on', '/hands-on/', '/hands-on/index.html', '/messages', '/messages/', '/messages/index.html', '/kolab/', '/kolab/hands-on/', '/konnect/', '/konnect/guide/']) {
      const { seen, served } = follow(`https://${host}${path}?a=1`, cachedOld);
      expect(served).not.toBeNull();
      expect(new URL(seen.at(-1)!).host).toBe('www.konjir.com');
      expect(seen.length - 1).toBeLessThanOrEqual(2);
      if (path.startsWith('/hands-on')) expect(served!.uri.startsWith('/kolab/hands-on/')).toBe(true);
      if (path.startsWith('/messages')) expect(served!.uri.startsWith('/konnect/guide/')).toBe(true);
    }
  }
});

test('a path holding "\\" passes through unchanged on either host, to be a 404, and on www so does one starting "//"', () => {
  for (const host of HOSTS) {
    for (const uri of ['/\\evil.example', '/\\evil.example/', '/a\\b', '/a/\\/', '/hands-on/\\evil.example', '/messages\\x']) {
      const r = request(host, uri, '');
      expect(handler({ request: r })).toBe(r);
      expect(r.uri).toBe(uri);
    }
  }
  const r = request('www.konjir.com', '//evil.example', '');
  expect(handler({ request: r })).toBe(r);
  expect(r.uri).toBe('//evil.example');
});

test('a redirect from the apex always names the fixed www host, whatever the path or the Host header holds', () => {
  for (const uri of ['//evil.example', '//evil.example/', '/hands-on//evil.example', '/@evil.example', '/.evil.example']) {
    const res = handler({ request: request('konjir.com', uri, '') }) as Response;
    expect(res.statusCode).toBe(301);
    expect(new URL(res.headers.location.value).host).toBe('www.konjir.com');
  }
  expect((handler({ request: request('konjir.com', '//evil.example', '') }) as Response).headers.location.value).toBe('https://www.konjir.com//evil.example');
  expect((handler({ request: request('konjir.com', '/hands-on//evil.example', '') }) as Response).headers.location.value).toBe('https://www.konjir.com/kolab/hands-on//evil.example');
  // A path that doesn't start with "/" (CloudFront sends none) could join the authority, so it passes.
  for (const uri of ['@evil.example', '.evil.example/', '']) {
    const r = request('konjir.com', uri, '');
    expect(handler({ request: r })).toBe(r);
  }
  // Only the apex itself redirects; a look-alike Host is served as www, never redirected to itself.
  for (const host of ['konjir.com.evil.example', 'evil.example', 'konjir.com:443', 'www.konjir.com']) {
    expect(handler({ request: request(host, '/', '') })).toMatchObject({ uri: '/' });
  }
});

test('without rawQueryString() the redirect drops the query rather than failing', () => {
  const r = request('konjir.com', '/messages/', 'a=1');
  delete r.rawQueryString;
  expect(handler({ request: r })).toStrictEqual(moved('https://www.konjir.com/konnect/guide/'));
  const apex = request('konjir.com', '/kolab/', 'a=1');
  delete apex.rawQueryString;
  expect(handler({ request: apex })).toStrictEqual(moved('https://www.konjir.com/kolab/'));
  const folder = request('www.konjir.com', '/kolab', 'a=1');
  delete folder.rawQueryString;
  expect(handler({ request: folder })).toStrictEqual(moved('/kolab/'));
});

test("konnect's app links and its sign-in redirect are served as they are on www, never redirected: /.well-known/ passes, and /konnect/app/oauth is its page in place, query and all", () => {
  for (const uri of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) {
    const r = request('www.konjir.com', uri, '');
    expect(handler({ request: r })).toBe(r);
    expect(r.uri).toBe(uri);
  }
  const r = request('www.konjir.com', '/konnect/app/oauth', 'code=kjc_secret&state=st&iss=https%3A%2F%2Fkolab.konjir.com');
  expect(handler({ request: r })).toBe(r);
  expect(r.uri).toBe('/konnect/app/oauth/index.html');
  // Only that path: a look-alike is a folder like any other.
  expect(handler({ request: request('www.konjir.com', '/konnect/app/oauth2', '') })).toStrictEqual(moved('/konnect/app/oauth2/'));
  // From the apex, to www as every request goes, the code's query kept as sent.
  expect(handler({ request: request('konjir.com', '/konnect/app/oauth', 'code=c&state=s') })).toStrictEqual(toWww('/konnect/app/oauth', 'code=c&state=s'));
});
