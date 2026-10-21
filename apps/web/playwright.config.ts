import { defineConfig } from '@playwright/test';

/**
 * The web interface's end-to-end tests (W3.1): a real Kolab, seeded as the prototype's example
 * (scripts/demo-server.ts), and the built page in Chromium; and a second Kolab that signs people in
 * through its own authorization server with a stub identity provider (scripts/signin-server.ts), for
 * signing in from a real browser (D55), and a third like it whose sign-ins expire in seconds. `npx nx run @konjir/web:e2e` builds the page first. Needs
 * Playwright's Chromium (`npx playwright install chromium`); CI doesn't run it.
 */
const port = Number(process.env.KONJIR_E2E_PORT ?? 7432);
const signinPort = Number(process.env.KONJIR_E2E_SIGNIN_PORT ?? port + 1);
export const TOKENS = process.env.KONJIR_DEMO_TOKENS ?? `${import.meta.dirname}/test-results/demo-tokens.json`;
/** The sign-in Kolab, and the file its invite's secret is written to. */
export const SIGNIN = `http://127.0.0.1:${signinPort}`;
export const INVITE = process.env.KONJIR_SIGNIN_INVITE ?? `${import.meta.dirname}/test-results/signin-invite.txt`;
/** A third Kolab like the second, whose sign-ins last `SHORT_TTL_S` seconds, for one that expires. */
export const SHORT_TTL_S = 4;
export const SIGNIN_SHORT = `http://127.0.0.1:${signinPort + 1}`;
/** A fourth, whose every sign-in is the same person, `ann`: for `konjir connect`, her agents signing in after her (W3.7). */
export const SIGNIN_ANN = `http://127.0.0.1:${signinPort + 2}`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', headless: true },
  webServer: [
    {
      command: 'npm run demo',
      url: `http://127.0.0.1:${port}/healthz`,
      env: { PORT: String(port), KONJIR_DEMO_TOKENS: TOKENS },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
    },
    {
      command: 'npm run signin-demo',
      url: `${SIGNIN}/healthz`,
      env: { PORT: String(signinPort), KONJIR_SIGNIN_INVITE: INVITE },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
    },
    {
      command: 'npm run signin-demo',
      url: `${SIGNIN_SHORT}/healthz`,
      env: { PORT: String(signinPort + 1), KONJIR_SIGNIN_INVITE: `${INVITE}.short`, KONJIR_SIGNIN_TTL_S: String(SHORT_TTL_S) },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
    },
    {
      command: 'npm run signin-demo',
      url: `${SIGNIN_ANN}/healthz`,
      env: { PORT: String(signinPort + 2), KONJIR_SIGNIN_INVITE: `${INVITE}.ann`, KONJIR_SIGNIN_AS: 'ann' },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
    },
  ],
});
