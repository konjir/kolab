// The page a browser lands on at the CLI's loopback listener once Kolab has answered: Konjir's
// standalone page (@konjir/brand), as Kolab's own sign-in pages are, saying how the sign-in ended.
import { expect, test } from '@jest/globals';
import { PALETTES, standalonePageCss } from '@konjir/brand';
import { callbackPage } from '../src/index.js';

test('the sign-in page is Konjir\'s: its tokens, wordmark and horizon, how the sign-in ended, and nothing loaded', () => {
  const ok = callbackPage(true, 'You can close this tab and return to your terminal.');
  expect(ok).toContain('<title>Signed in · Konjir</title>');
  expect(ok).toContain('<h1>Signed in.</h1>');
  expect(ok).toContain('<p class="kj-state">konjir has your sign-in.</p>');
  expect(ok).toContain('You can close this tab and return to your terminal.');
  expect(ok).toContain(standalonePageCss());
  expect(ok).toContain(`--surface:${PALETTES.dark.surface}`);
  expect(ok).toContain(`--surface:${PALETTES.light.surface}`);
  expect(ok).toContain('class="kj-wordmark"');
  expect(ok).toContain('class="kj-horizon"');
  expect(ok).not.toMatch(/\sstyle=|<script|<link|<img|url\(|@import/);

  const stopped = callbackPage(false, 'Return to your terminal: it says why.');
  expect(stopped).toContain('<title>Sign-in stopped · Konjir</title>');
  expect(stopped).toContain('<h1>Sign-in stopped.</h1>');
  expect(stopped).toContain('<p class="kj-state stopped">konjir was not signed in.</p>');
  // What it is told to say is text, never markup.
  expect(callbackPage(false, '<img src=x onerror=alert(1)>')).toContain('&lt;img src=x onerror=alert(1)&gt;');
});
