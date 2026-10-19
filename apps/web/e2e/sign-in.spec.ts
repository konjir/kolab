// Signing in from a real browser (D55): Chromium submits Kolab's own consent form, and the web
// interface makes its changes, against a Kolab with a stub identity provider in place of GitHub
// (scripts/signin-server.ts). Kolab refuses a change whose Origin isn't its own, and a browser sends
// `Origin: null` with a page's own form POST when the page's referrer policy is no-referrer, so
// these check what the browser actually sends, not what a test sets by hand.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { INVITE, SIGNIN } from '../playwright.config.js';

test.use({ baseURL: SIGNIN });

interface Change { method: string; path: string; origin: string | undefined; status: number }

/** Every change the page sends Kolab, with the Origin the browser gave it and Kolab's answer. */
function changesOf(page: Page): Change[] {
  const seen: Change[] = [];
  page.on('response', async (res) => {
    const req = res.request();
    const u = new URL(req.url());
    if (u.origin !== SIGNIN || req.method() === 'GET' || req.method() === 'HEAD') return;
    seen.push({ method: req.method(), path: u.pathname, origin: (await req.allHeaders()).origin, status: res.status() });
  });
  return seen;
}

/** From Kolab's page to its consent page, through the stub provider, as someone new. */
async function toConsent(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in with Stub' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Kolab' })).toBeVisible();
  await expect(page).toHaveURL(/\/oauth\/callback\/stub\?/);
}

test('the consent form and the web interface\'s changes carry Kolab\'s own Origin, and go through', async ({ page }) => {
  const changes = changesOf(page);
  await toConsent(page);
  const login = (await page.locator('code').first().textContent())!;

  // Someone new makes their first kolab here, private, named after them.
  await expect(page.getByRole('radio', { name: /A new private kolab of your own/ })).toBeChecked();
  await expect(page.getByLabel('The new kolab\'s short name')).toHaveValue(login);
  await page.getByLabel('The new kolab\'s title').fill('My first kolab');
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByText(/^Working as/)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
  expect(changes).toContainEqual({ method: 'POST', path: '/oauth/consent', origin: SIGNIN, status: 303 });

  // Signed in, the person opens an invite's link and joins its kolab: the page's own POSTs.
  const invite = readFileSync(INVITE, 'utf8').trim();
  await page.goto(`/#/invite/${invite}`);
  await page.getByRole('button', { name: 'Join accounts' }).click();
  await expect(page.getByText(/Joined accounts/)).toBeVisible();
  expect(changes).toContainEqual({ method: 'POST', path: '/api/session/invite', origin: SIGNIN, status: 200 });
  expect(changes).toContainEqual({ method: 'POST', path: '/api/session/invite/accept', origin: SIGNIN, status: 200 });

  // Signing out is a change too.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Stub' })).toBeVisible();
  expect(changes).toContainEqual({ method: 'DELETE', path: '/api/session', origin: SIGNIN, status: 204 });
  // Nothing the browser sent was refused for its origin.
  expect(changes.filter((c) => c.origin !== SIGNIN || c.status === 403)).toStrictEqual([]);
});

test('denying at the consent page is a change from Kolab\'s own page too: it goes through, and says so', async ({ page }) => {
  const changes = changesOf(page);
  await toConsent(page);
  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByRole('alert')).toHaveText(/Signing in was cancelled/);
  expect(changes).toStrictEqual([{ method: 'POST', path: '/oauth/consent', origin: SIGNIN, status: 303 }]);
});
