// What the Konjir Kolab prototype simulates, against a real Kolab (W3.1's done-when): a product
// owner reads the spec with its questions beside each element, answers one, asks one, edits a
// requirement and submits it for review; another person approves it in the page; an engineer
// sees what went stale and says it still holds; every page stays live as the others act; and
// the product owner makes a kolab of her own, switches role, and comes back through the picker.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { TOKENS } from '../playwright.config.js';

const token = (who: string) => (JSON.parse(readFileSync(TOKENS, 'utf8')) as Record<string, string>)[who];
const shots = process.env.KONJIR_E2E_SHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };

async function signIn(page: Page, who: string) {
  await page.goto('/');
  await page.getByLabel('Session token').fill(token(who));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/^Working as/)).toBeVisible();
}

test('a product owner does what the prototype simulates, against the real server', async ({ browser }) => {
  const lee = await (await browser.newContext()).newPage();
  await signIn(lee, 'lee');
  // The spec, with the open question beside PR3, and the summary of what waits.
  await expect(lee.getByRole('heading', { name: 'Password reset', level: 2 })).toBeVisible();
  await expect(lee.getByRole('heading', { level: 1 })).toHaveText('1 question waits on you.');
  const pr3 = lee.locator('li.el', { has: lee.getByRole('button', { name: 'PR3', exact: true }) });
  await expect(pr3.getByText(/Should the response time be indistinguishable too/)).toBeVisible();
  await shot(lee, '1-spec');

  // Lee answers it there.
  await pr3.getByLabel(/^Answer\./).fill('Yes. Pad both responses to the same time.');
  await pr3.getByRole('button', { name: 'Answer' }).click();
  await expect(pr3.getByText('Yes. Pad both responses to the same time.')).toBeVisible();

  // The engineer, in another browser, sees B9 stale against PR8, and says it still holds.
  const eng = await (await browser.newContext()).newPage();
  await signIn(eng, 'eli');
  await eng.getByRole('button', { name: 'Password reset on Postgres' }).click();
  const b9 = eng.locator('li.el', { has: eng.getByRole('button', { name: 'B9', exact: true }) });
  await expect(b9.locator('.diff del')).toHaveText('5');
  await shot(eng, '2-binding-stale');

  // A token that isn't a person's open session is refused (an agent's too: apps/server/test/web.test.ts).
  const agent = await (await browser.newContext()).newPage();
  await agent.goto('/');
  await agent.getByLabel('Session token').fill('kjs_not-a-person');
  await agent.getByRole('button', { name: 'Sign in' }).click();
  await expect(agent.getByRole('alert')).toBeVisible();

  // Lee edits PR1 and submits; Pat and pm-agent, the other writers of the functional layer, are asked.
  await lee.locator('li.el', { has: lee.getByRole('button', { name: 'PR1', exact: true }) }).getByRole('button', { name: 'Edit' }).click();
  await lee.getByLabel('Edit PR1').fill('A user who has forgotten their password can request a reset link by entering their email address or username.');
  await lee.getByRole('button', { name: 'Keep in draft' }).click();
  await lee.getByRole('button', { name: 'Submit for review' }).click();
  await expect(lee.getByText(/pat.*been asked to review it/)).toBeVisible();
  await expect(lee.getByRole('region', { name: 'In review' })).toBeVisible();

  // Pat approves it in the page.
  const pm = await (await browser.newContext()).newPage();
  await signIn(pm, 'pat');
  await expect(pm.getByRole('region', { name: 'In review' })).toBeVisible();
  await shot(pm, '3-review');
  await pm.getByRole('button', { name: 'Approve' }).click();
  await expect(pm.getByRole('heading', { name: /Committed kj:password-reset@4/ })).toBeVisible();

  // Lee's page heard it: v4 is committed, without a reload.
  await expect(lee.getByRole('button', { name: 'v4', exact: true })).toBeVisible({ timeout: 15_000 });
  // The engineer's page heard it too: B1 relied on PR1, so it is stale now.
  const b1 = eng.locator('li.el', { has: eng.getByRole('button', { name: 'B1', exact: true }) });
  await expect(b1.locator('.markbox')).toBeVisible({ timeout: 15_000 });
  await b1.getByRole('button', { name: 'Still holds' }).click();
  await expect(b1.locator('.markbox')).toHaveCount(0);
  // B9 and B10 rely on PR8, which v3 tightened: the engineer checks each and says it still holds.
  for (let n = await eng.getByRole('button', { name: 'Still holds' }).count(); n > 0; n--) {
    await eng.getByRole('button', { name: 'Still holds' }).first().click();
    await expect(eng.getByRole('button', { name: 'Still holds' })).toHaveCount(n - 1);
  }
  await expect(eng.getByRole('heading', { level: 1 })).toHaveText('Everything holds.');

  // Lee asks the binding a question; it waits on the engineer.
  await lee.getByRole('button', { name: 'Password reset on Postgres' }).click();
  await lee.locator('li.el', { has: lee.getByRole('button', { name: 'B10', exact: true }) }).getByRole('button', { name: 'Ask' }).click();
  await lee.getByLabel(/Ask about/).fill('Is the background job retried if the email provider is down?');
  await lee.locator('form.ask-form').getByRole('button', { name: 'Ask', exact: true }).click();
  await eng.getByRole('button', { name: 'Questions' }).click();
  await expect(eng.getByText('Is the background job retried if the email provider is down?')).toBeVisible({ timeout: 15_000 });

  // Lineage and activity.
  await lee.getByRole('button', { name: 'Lineage' }).click();
  await expect(lee.locator('svg.wires path').first()).toBeAttached();
  await shot(lee, '4-lineage');
  await lee.getByRole('button', { name: 'Activity' }).click();
  await expect(lee.getByText(/approved kj:password-reset@4/)).toBeVisible();
  await shot(lee, '5-activity');

  // Lee makes a kolab of her own: the session moves into it, empty.
  await lee.getByRole('button', { name: 'All kolabs' }).click();
  await lee.locator('#kTitle').fill('Billing');
  await expect(lee.getByLabel('Short name')).toHaveValue('billing');
  await lee.getByRole('button', { name: 'Create kolab' }).click();
  await expect(lee.getByRole('heading', { level: 1 })).toHaveText('Nothing written yet. Start with the spec.');
  await expect(lee.locator('.kolab-btn .nm')).toHaveText('Billing');
  // She switches to the engineer role there, and back to Accounts through the picker, as product.
  await lee.getByRole('radio', { name: 'engineer' }).click();
  await expect(lee.getByRole('radio', { name: 'engineer' })).toHaveAttribute('aria-checked', 'true');
  await lee.locator('.kolab-btn').click();
  await lee.getByRole('button', { name: /Accounts/ }).click();
  await expect(lee.locator('.kolab-btn .nm')).toHaveText('Accounts');
  await lee.getByRole('radio', { name: 'product' }).click();
  await expect(lee.getByRole('heading', { name: 'Password reset', level: 2 })).toBeVisible();

  // Signing out ends the session and returns to the sign-in page.
  await lee.getByRole('button', { name: 'Sign out' }).click();
  await expect(lee.getByLabel('Session token')).toBeVisible();
});
