// Who holds access, in a real browser (W3.6): someone new makes their own kolab, invites a teammate
// from the People page, the teammate joins with the link in a browser of their own, and the kolab's
// owner then sees them in the list, changes their level and removes them, confirming each, with
// every change the page sends carrying Kolab's own Origin. Against the sign-in Kolab
// (scripts/signin-server.ts), whose stub provider signs in someone new each time.
import { expect, test, type Page } from '@playwright/test';
import { SIGNIN } from '../playwright.config.js';

test.use({ baseURL: SIGNIN });

/** Signs someone new in from Kolab's page, through the stub provider, to the consent page; returns their login. */
async function toConsent(page: Page): Promise<string> {
  await page.getByRole('link', { name: 'Sign in with Stub' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Kolab' })).toBeVisible();
  return (await page.locator('code').first().textContent())!;
}

test('an owner lists who holds access, changes a teammate\'s level and removes them, confirming each, and the teammate\'s session ends', async ({ page, browser }) => {
  const changes: { path: string; origin: string | undefined; status: number }[] = [];
  page.on('response', async (res) => {
    const req = res.request();
    if (req.method() === 'POST' && new URL(req.url()).pathname.startsWith('/api/access')) {
      changes.push({ path: new URL(req.url()).pathname, origin: (await req.allHeaders()).origin, status: res.status() });
    }
  });

  // The owner: someone new, with a first kolab of their own.
  await page.goto('/');
  const owner = await toConsent(page);
  await page.getByLabel('The new kolab\'s title').fill('Team kolab');
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByText(/^Working as/)).toBeVisible();

  // People: only the owner holds access yet. An invite for an engineer.
  await page.goto('/#/people');
  const list = page.getByRole('list', { name: 'People and agents' });
  await expect(list.getByRole('listitem', { name: owner })).toContainText(`owns ${owner}: Admin`);
  await page.getByLabel('Access', { exact: true }).selectOption('write-technical');
  await page.getByRole('button', { name: 'Make an invite link' }).click();
  const link = (await page.getByLabel('The invite link').textContent())!;

  // The teammate joins with it, in a browser of their own.
  const other = await browser.newContext();
  const mate = await other.newPage();
  await mate.goto(link);
  await expect(mate.getByRole('region', { name: 'Invite' })).toBeVisible();
  const teammate = await toConsent(mate);
  await mate.getByRole('button', { name: 'Allow' }).click();
  await expect(mate.getByText(/^Working as/)).toBeVisible();

  // The owner sees them, with their grant, and changes it to Read, confirming first.
  await page.reload();
  const row = list.getByRole('listitem', { name: teammate });
  await expect(row).toContainText('granted Write on the technical layer');
  await row.getByLabel(`Grant for ${teammate}`).selectOption('read');
  await row.getByRole('button', { name: 'Change' }).click();
  const ask = page.getByRole('alertdialog', { name: `Change ${teammate}'s access?` });
  await expect(ask).toContainText('From Write on the technical layer to Read.');
  await ask.getByRole('button', { name: 'Change access' }).click();
  await expect(row).toContainText('granted Read');

  // Then removes them: they are gone from the list, and the teammate's session with them.
  await row.getByRole('button', { name: 'Remove access' }).click();
  await page.getByRole('alertdialog', { name: `Remove ${teammate}'s access?` }).getByRole('button', { name: 'Remove access' }).click();
  await expect(list.getByRole('listitem', { name: teammate })).toHaveCount(0);
  await expect(list.getByRole('listitem', { name: owner })).toBeVisible();
  await mate.reload();
  await expect(mate.getByRole('link', { name: 'Sign in with Stub' })).toBeVisible();

  expect(changes).toStrictEqual([
    { path: `/api/access/${teammate}`, origin: SIGNIN, status: 200 },
    { path: `/api/access/${teammate}/remove`, origin: SIGNIN, status: 200 },
  ]);
  await other.close();
});
