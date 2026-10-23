// konjir.com's CloudFront Function (deploy/terraform/modules/site/www-redirect.js.tftpl, D81):
// www.konjir.com answers with a 301 to the apex, keeping the path and the raw query string as the
// browser sent it; every other host passes through untouched. CloudFront's own runtime isn't
// available here, so this runs the function's code as Terraform renders it against events shaped
// like CloudFront's.
import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const template = readFileSync(resolve(import.meta.dirname, '../../../deploy/terraform/modules/site/www-redirect.js.tftpl'), 'utf8');
const code = template.replaceAll('${www}', 'www.konjir.com').replaceAll('${apex}', 'konjir.com');
type Request = { uri: string; headers: Record<string, { value: string }>; querystring: Record<string, unknown>; rawQueryString?: () => string };
const handler = runInNewContext(`${code}\nhandler`) as (event: { request: Request }) => unknown;

const request = (host: string | undefined, uri: string, raw: string): Request => ({
  uri,
  headers: host === undefined ? {} : { host: { value: host } },
  querystring: {},
  rawQueryString: () => raw,
});

test('the template has nothing left for Terraform to fill', () => {
  expect(code).not.toMatch(/\$\{/);
});

test('www answers with a 301 to the apex, path and raw query string untouched', () => {
  const raw = 'a=1&b=%26x%3Dy&c&next=%2Fdocs%23top&a=2';
  expect(handler({ request: request('www.konjir.com', '/some/path', raw) })).toStrictEqual({
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: { location: { value: `https://konjir.com/some/path?${raw}` } },
  });
  expect(handler({ request: request('WWW.Konjir.com', '/', '') })).toStrictEqual({
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: { location: { value: 'https://konjir.com/' } },
  });
});

test('the apex, other hosts and a missing host pass through as they came', () => {
  for (const host of ['konjir.com', 'kolab.konjir.com', 'www.konjir.com.evil.example', 'evilwww.konjir.com', undefined]) {
    const r = request(host, '/x', 'q=1');
    expect(handler({ request: r })).toBe(r);
  }
});

test('the location is always the fixed apex, whatever the path holds', () => {
  const res = handler({ request: request('www.konjir.com', '//evil.example/x', '') }) as { headers: { location: { value: string } } };
  expect(res.headers.location.value).toBe('https://konjir.com//evil.example/x');
  expect(new URL(res.headers.location.value).host).toBe('konjir.com');
});

test('without rawQueryString() the redirect drops the query rather than failing', () => {
  const r = request('www.konjir.com', '/p', 'a=1');
  delete r.rawQueryString;
  expect(handler({ request: r })).toMatchObject({ statusCode: 301, headers: { location: { value: 'https://konjir.com/p' } } });
});
