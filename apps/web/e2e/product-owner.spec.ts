// What the Konjir Kolab prototype simulates, against a real Kolab (W3.1's done-when): a product
// owner reads the spec with its questions beside each element, answers one, asks one, edits a
// requirement and submits it for review; another person approves it in the page; an engineer
// sees what went stale and says it still holds; every page stays live as the others act; and
// the product owner makes a kolab of her own, switches role, and comes back through the picker.
// W3.2: an engineer disputes a requirement in a case file, a product person takes the other side,
// and the product owner, who isn't a party, rules; the ruling is precedent beside the requirement,
// marks it until a version amends it, and she amends it. She reads her other kolab's committed work
// in place, and an address she can't read is refused as one that isn't there.
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

  // Eli, the engineer, finds PR3 can't be met as written and opens a case file on it (CASE5).
  await eng.getByRole('button', { name: 'Password reset', exact: true }).click();
  const engPr3 = eng.locator('li.el', { has: eng.getByRole('button', { name: 'PR3', exact: true }) });
  await engPr3.getByRole('button', { name: 'Dispute' }).click();
  await engPr3.getByLabel('The question in dispute').fill('Must the response time be indistinguishable too?');
  await engPr3.getByLabel('Your claim').fill('The same body isn\'t enough: a faster 202 for unknown emails still reveals whether an account exists.');
  await engPr3.getByRole('button', { name: 'Open case file' }).click();
  await expect(engPr3.locator('.casebox')).toContainText('one person and their agents are one side');

  // Pat sees it beside PR3, live, and takes the other side.
  const pmPr3 = pm.locator('li.el', { has: pm.getByRole('button', { name: 'PR3', exact: true }) });
  await expect(pmPr3.locator('.casebox')).toBeVisible({ timeout: 15_000 });
  await pmPr3.getByRole('button', { name: 'Take the other side' }).click();
  await pmPr3.getByLabel('Your position: the other side').fill('PR3 is about what the page shows; timing belongs in its own requirement.');
  await pmPr3.getByLabel('Evidence, one per line').fill('kj:password-reset#PR3');
  await pmPr3.locator('.casebox form button[type=submit]').click();
  await expect(pmPr3.locator('.position')).toHaveCount(2);

  // Lee, who holds no side, rules from the Cases page: she sustains Eli's position, so the intent changes.
  await lee.getByRole('button', { name: /^Cases/ }).click();
  const theCase = lee.locator('.casebox').first();
  await theCase.getByLabel(/Sustain eli’s: change the intent/).check({ timeout: 15_000 });
  await theCase.getByLabel('The ruling, as agents will be served it').fill('The response time must be indistinguishable too: pad both to the same duration.');
  await shot(lee, '6-case');
  await theCase.locator('button[type=submit]').click();
  await expect(lee.getByRole('heading', { name: 'Settled case files' })).toBeVisible();
  await expect(lee.locator('.rulingbox').first()).toContainText('pad both to the same duration');

  // Beside PR3: the ruling as precedent, and a mark no one clears by hand. Lee amends PR3; Pat approves; the mark settles.
  await lee.getByRole('button', { name: 'Password reset', exact: true }).click();
  const leePr3 = lee.locator('li.el', { has: lee.getByRole('button', { name: 'PR3', exact: true }) });
  await expect(leePr3.locator('.rulingbox')).toBeVisible();
  await expect(leePr3.locator('.markbox')).toContainText('can’t be cleared by hand');
  await shot(lee, '7-ruled');
  await leePr3.getByRole('button', { name: 'Revise PR3' }).click();
  await lee.getByLabel('Edit PR3').fill('The request page shows the same response, in the same time, whether or not the email belongs to an account.');
  await lee.getByRole('button', { name: 'Keep in draft' }).click();
  await lee.getByRole('button', { name: 'Submit for review' }).click();
  await expect(pm.getByRole('region', { name: 'In review' })).toBeVisible({ timeout: 15_000 });
  await pm.getByRole('button', { name: 'Approve' }).click();
  await expect(leePr3.locator('.markbox')).toHaveCount(0, { timeout: 15_000 });
  await expect(leePr3.locator('.rulingbox')).toBeVisible();

  // Lee reads her other kolab, Checkout, in place: its committed spec, not her draft of it, and nothing to change from here.
  await lee.getByRole('button', { name: 'All kolabs' }).click();
  await lee.locator('article.kcard', { hasText: 'Checkout' }).getByRole('button', { name: 'Read here' }).click();
  await lee.getByRole('button', { name: 'kj:checkout/checkout@2' }).click();
  await expect(lee.getByRole('heading', { name: 'Checkout', level: 2 })).toBeVisible();
  await expect(lee.getByText(/Read in place from kolab/)).toBeVisible();
  await expect(lee.getByText('Pressing Pay more than once, or retrying after a timeout, charges the card once.')).toBeVisible();
  await expect(lee.getByText(/If the email provider is down/)).toBeVisible();
  await expect(lee.getByText(/within five minutes/)).toHaveCount(0);
  await expect(lee.locator('li.el').getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await shot(lee, '8-read-in-place');
  // An address goes there too, at a version; one she can't read is refused as one that isn't there.
  await lee.getByLabel('Go to an address').fill('kj:checkout/checkout@1#R3');
  await lee.getByLabel('Go to an address').press('Enter');
  await expect(lee.getByText('A payment is never taken twice.')).toBeVisible();
  await lee.getByLabel('Go to an address').fill('kj:nowhere/secret');
  await lee.getByLabel('Go to an address').press('Enter');
  await expect(lee.getByRole('alert')).toHaveText('no node secret in kolab nowhere');

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
