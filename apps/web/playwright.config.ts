import { defineConfig } from '@playwright/test';

/**
 * The web interface's end-to-end test (W3.1): a real Kolab, seeded as the prototype's example
 * (scripts/demo-server.ts), and the built page in Chromium. `npx nx run @konjir/web:e2e` builds the
 * page first. Needs Playwright's Chromium (`npx playwright install chromium`); CI doesn't run it.
 */
const port = Number(process.env.KONJIR_E2E_PORT ?? 7432);
export const TOKENS = process.env.KONJIR_DEMO_TOKENS ?? `${import.meta.dirname}/test-results/demo-tokens.json`;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium', headless: true },
  webServer: {
    command: 'npm run demo',
    url: `http://127.0.0.1:${port}/healthz`,
    env: { PORT: String(port), KONJIR_DEMO_TOKENS: TOKENS },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
  },
});
