// @konjir/brand: the tokens are stated once, and everything that shows them says what they say:
// the web page's generated style sheet, the brand's own SVG files, the marketing site's theme key.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@jest/globals';
import {
  FONTS, HORIZON_HTML, PALETTES, RADII, SKY, THEMES, THEME_NAMES, THEME_STORAGE_KEY, WORDMARK, WORDMARK_CSS,
  constantsCss, escapeHtml, paletteCss, standalonePage, standalonePageCss, themeCss, wordmarkSvg, type Palette,
} from '../src/index.js';
import { webCss } from '../scripts/web-css-text.js';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

test('both themes name the same tokens, each a six-digit color, and the names a person reads', () => {
  expect([...THEMES]).toStrictEqual(['dark', 'light']);
  expect(THEME_NAMES).toStrictEqual({ dark: 'Predawn', light: 'Daybreak' });
  const tokens = Object.keys(PALETTES.dark).sort();
  expect(Object.keys(PALETTES.light).sort()).toStrictEqual(tokens);
  for (const t of THEMES) for (const v of Object.values(PALETTES[t])) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  // The horizon's bands are tokens, top of the sky to the field.
  for (const band of SKY) expect(tokens).toContain(band);
});

test('the tokens are the brand\'s: the wordmark files in brand/ carry each theme\'s ink, sun and moon, and the wordmark\'s geometry', () => {
  for (const [theme, file] of [['dark', 'konjir-wordmark-on-dark.svg'], ['light', 'konjir-wordmark-on-light.svg']] as const) {
    const svg = read('brand', file);
    const p = PALETTES[theme];
    expect(svg.toLowerCase()).toContain(`stroke="${p.ink}"`);
    expect(svg.toLowerCase()).toContain(`fill="${p.sun}"`);
    expect(svg.toLowerCase()).toContain(`fill="${p.moon}"`);
    expect(svg).toContain(`viewBox="${WORDMARK.viewBox}"`);
    for (const d of WORDMARK.letters) expect(svg).toContain(`d="${d}"`);
    expect(svg).toContain(`d="${WORDMARK.moon}"`);
    expect(svg).toContain(`r="${WORDMARK.sun.r}"`);
    // Drawn with a theme, the library's wordmark is that file's drawing.
    const drawn = wordmarkSvg({ theme, height: 56 });
    for (const d of [...WORDMARK.letters, WORDMARK.moon]) expect(drawn).toContain(`d="${d}"`);
    expect(drawn).toContain(`stroke="${p.ink}"`);
    expect(drawn).toContain(`fill="${p.sun}"`);
    expect(drawn).toContain(`width="122" height="56"`);
  }
  // brand/README.md states the grounds and the lights.
  const readme = read('brand', 'README.md').toLowerCase();
  for (const v of [PALETTES.dark.surface, PALETTES.dark.ink, PALETTES.dark.sun, PALETTES.dark.moon, PALETTES.light.surface, PALETTES.light.ink, PALETTES.light.sun, PALETTES.light.moon]) expect(readme).toContain(v);
});

test('as CSS: Predawn by default, Daybreak where the system prefers light or the page says so, and the constants once', () => {
  const css = themeCss();
  const [dark, system, chosen] = css.split('\n');
  expect(dark.startsWith(':root{--surface:#16140f;')).toBe(true);
  expect(dark).toContain('color-scheme:dark');
  expect(dark).toContain(`--font-display:${FONTS.display}`);
  expect(dark).toContain(`--r-md:${RADII.md}`);
  expect(system).toBe(`@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${paletteCss('light')}}}`);
  expect(chosen).toBe(`:root[data-theme="light"]{${paletteCss('light')}}`);
  expect(css.split(constantsCss())).toHaveLength(2);
  // Every token of every theme is a custom property of its name.
  for (const t of THEMES) for (const [k, v] of Object.entries(PALETTES[t]) as [keyof Palette, string][]) expect(paletteCss(t)).toContain(`--${k}:${v}`);
});

test('the web page\'s brand.css is what the tokens say: run npm run brand after changing them', () => {
  expect(read('apps', 'web', 'src', 'brand.css')).toBe(webCss());
  // And it is the only place the web page states a token: styles.css defines none of them.
  const styles = read('apps', 'web', 'src', 'styles.css');
  for (const k of Object.keys(PALETTES.dark)) expect(styles).not.toMatch(new RegExp(`(^|[\\s;{])--${k}\\s*:`));
  expect(styles).not.toMatch(/--font-(display|sans|mono)\s*:/);
  // The values survive the formatting: parsed back, they are the palettes.
  const declared = (block: string) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*([^;}\n]+)/g)].map((m) => [m[1], m[2].trim()]));
  const text = webCss();
  expect(declared(text.slice(text.indexOf(':root{'), text.indexOf('@media')))).toMatchObject(PALETTES.dark);
  expect(declared(text.slice(text.indexOf(':root[data-theme="light"]')))).toMatchObject(PALETTES.light);
});

test('the marketing site keeps the theme under the same key', () => {
  expect(THEME_STORAGE_KEY).toBe('konjir.theme');
  expect(read('deploy', 'site', 'site.js')).toContain(`var KEY = '${THEME_STORAGE_KEY}'`);
});

test('a standalone page is whole, loads nothing, and carries no style attribute: its one style sheet colors the wordmark and the horizon', () => {
  const css = standalonePageCss();
  expect(css).toContain(themeCss());
  expect(css).toContain(WORDMARK_CSS);
  const html = standalonePage({ title: 'Signed in <&> "Konjir"', body: '<h1>Signed in.</h1>', css });
  expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
  expect(html).toContain('<title>Signed in &lt;&amp;&gt; &quot;Konjir&quot;</title>');
  expect(html).toContain(`<style>${css}</style>`);
  expect(html).toContain('<main class="kj-page">');
  expect(html).toContain('<h1>Signed in.</h1>');
  expect(html).toContain(HORIZON_HTML);
  expect(HORIZON_HTML.match(/<i><\/i>/g)).toHaveLength(SKY.length);
  // Nothing a strict policy (default-src 'none'; style-src by hash) would block.
  expect(html).not.toMatch(/\sstyle=|<script|<link|<img|url\(|@import|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  // Without a theme the wordmark takes its colors from the sheet, by class.
  const mark = wordmarkSvg();
  expect(mark).toContain('class="kj-wordmark"');
  expect(mark).not.toMatch(/fill="#|stroke="#/);
  expect(mark).toContain('role="img" aria-label="Konjir"');
  expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
