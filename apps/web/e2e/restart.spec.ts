// A tab left open across a restart of Kolab (a deploy): while Kolab is away its proxy answers 502,
// and the page waits it out rather than signing the person out; a session that really ends shows
// this Kolab's own sign-in, with its identity provider, never a token form it doesn't offer.
import { expect, test, type Page, type Route } from '@playwright/test';
import { SIGNIN } from '../playwright.config.js';

test.use({ baseURL: SIGNIN });

/**
 * Keeps the page's event streams within the test's reach, so it can drop one as the browser does
 * when a reconnect meets the proxy's 502: the stream closed for good, with an error.
 */
async function watchStreams(page: Page) {
  await page.addInitScript(() => {
    const Real = window.EventSource;
    const w = window as unknown as { __streams: EventSource[] };
    w.__streams = [];
    window.EventSource = class extends Real {
      constructor(url: string | URL, init?: EventSourceInit) { super(url, init); w.__streams.push(this); }
    };
  });
}
const streams = (page: Page) => page.evaluate(() => (window as unknown as { __streams: EventSource[] }).__streams.length);
const dropStream = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __streams: EventSource[] }).__streams.at(-1)!;
  s.close();
  s.dispatchEvent(new Event('error'));
});

/** Someone new signs in through the stub identity provider, into a kolab of their own. */
async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in with Stub' }).click();
  await page.getByLabel('The new kolab\'s title').fill('Across a restart');
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByText(/^Working as/)).toBeVisible();
}

test('Kolab away (the proxy\'s 502, the stream dropped) doesn\'t sign the page out, and it recovers when Kolab is back', async ({ page }) => {
  await watchStreams(page);
  await signIn(page);
  expect(await streams(page)).toBe(1);
  // Kolab restarting: every /api call meets the proxy's 502, and the open stream drops.
  const away = (route: Route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body><h1>502 Bad Gateway</h1></body></html>' });
  await page.route('**/api/**', away);
  await dropStream(page);
  await page.evaluate(() => { location.hash = '#/activity'; });
  await expect(page.getByText('Kolab is restarting: reconnecting…')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Sign in to Kolab' })).toHaveCount(0);

  // Kolab is back: the page carries on, signed in.
  await page.unroute('**/api/**', away);
  await expect(page.getByText('Kolab is restarting: reconnecting…')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText(/^Working as/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to Kolab' })).toHaveCount(0);
  await expect.poll(() => streams(page)).toBe(2);
  await expect(page.getByLabel('Session token')).toHaveCount(0);
});

test('a session that ends while the tab is open shows Sign in with the identity provider, not the token form', async ({ page }) => {
  await signIn(page);
  // The session ends from elsewhere: its cookie, used outside the page, signs it out.
  const ended = await page.request.delete('/api/session', { headers: { origin: SIGNIN } });
  expect(ended.status()).toBe(204);
  await expect(page.getByRole('link', { name: 'Sign in with Stub' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Session token')).toHaveCount(0);
  await expect(page.getByText(/admin_open_session/)).toHaveCount(0);
});
