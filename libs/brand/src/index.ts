/**
 * Konjir's design tokens and marks, stated once: the two themes' colors, the type, the radii, the
 * wordmark, and the CSS that carries them. Pure data and string functions with no dependency and
 * no Node or browser API, so the same module is read by the web page (apps/web, whose brand.css is
 * generated from it), by Kolab's own pages (apps/server, the sign-in, consent and setup pages) and
 * by the CLI's sign-in page (libs/login, the loopback page a browser lands on).
 *
 * The values are the Konjir design system's (brand/README.md): Predawn, the dark theme, is the
 * default, and Daybreak the light one.
 */

/** The themes, by the name the page's `data-theme` attribute and its stored choice use. */
export const THEMES = ['dark', 'light'] as const;
export type Theme = typeof THEMES[number];

/** What each theme is called where a person reads its name. */
export const THEME_NAMES: Record<Theme, string> = { dark: 'Predawn', light: 'Daybreak' };

/** Where a page keeps the person's choice of theme (localStorage); absent, the system's preference decides. */
export const THEME_STORAGE_KEY = 'konjir.theme';

/** The tagline and the descriptor, as they are written. */
export const TAGLINE = 'Name it true.';
export const DESCRIPTOR = 'Where intent is spoken once, and agents answer.';

/** A theme's colors, by token: each is the CSS custom property `--<token>`. */
export interface Palette {
  surface: string; 'surface-raised': string; 'surface-sunken': string;
  line: string; 'line-strong': string;
  ink: string; 'ink-muted': string; secondary: string;
  accent: string; 'on-accent': string; 'accent-soft': string; focus: string;
  /** The four states of a mark: in step, stale, a question, a boundary crossed. */
  clean: string; stale: string; question: string; boundary: string;
  /** The wordmark's two lights. */
  sun: string; moon: string;
  /** The horizon bands, from the top of the sky to the field. */
  'sky-zenith': string; 'sky-veil': string; 'sky-glow': string; 'sky-horizon': string; 'sky-field': string;
  /** Text added and removed, in a diff. */
  ins: string; del: string;
}

/** Predawn, the dark theme: the default. */
const PREDAWN: Palette = {
  surface: '#16140f', 'surface-raised': '#211e18', 'surface-sunken': '#0e0d09',
  line: '#3a352c', 'line-strong': '#776f5f',
  ink: '#f2ebd3', 'ink-muted': '#aeadb3', secondary: '#9ea4ba',
  accent: '#e9ba7b', 'on-accent': '#16140f', 'accent-soft': '#2e2618', focus: '#fef6bf',
  clean: '#8fb7c9', stale: '#e9ba7b', question: '#b9b3d6', boundary: '#f08a5d',
  sun: '#e9ba7b', moon: '#fef6bf',
  'sky-zenith': '#656c82', 'sky-veil': '#aeadb3', 'sky-glow': '#fef6bf', 'sky-horizon': '#e9ba7b', 'sky-field': '#77695d',
  ins: '#24321f', del: '#3a2219',
};

/** Daybreak, the light theme. Its sky keeps Predawn's zenith and veil. */
const DAYBREAK: Palette = {
  surface: '#f8f2d6', 'surface-raised': '#fdf9e8', 'surface-sunken': '#efe8cc',
  line: '#d9d1b4', 'line-strong': '#8c8470',
  ink: '#1e1b15', 'ink-muted': '#57586a', secondary: '#4a5166',
  accent: '#8a5410', 'on-accent': '#fff8e6', 'accent-soft': '#f3e3bf', focus: '#8a5410',
  clean: '#2c6378', stale: '#8a5410', question: '#5a4f8c', boundary: '#a8401c',
  sun: '#b5741f', moon: '#3a3f52',
  'sky-zenith': PREDAWN['sky-zenith'], 'sky-veil': PREDAWN['sky-veil'], 'sky-glow': '#f0d79b', 'sky-horizon': '#d9a15c', 'sky-field': '#16140f',
  ins: '#dfe9cf', del: '#f3d6c8',
};

export const PALETTES: Record<Theme, Palette> = { dark: PREDAWN, light: DAYBREAK };

/** The faces, each with what stands in where it isn't loaded: `--font-display`, `--font-sans`, `--font-mono`. */
export const FONTS = {
  display: '"Fraunces Variable", "Fraunces", Georgia, "Times New Roman", serif',
  sans: '"Instrument Sans Variable", "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** The corner radii: `--r-hair`, `--r-md`, `--r-full`. */
export const RADII = { hair: '2px', md: '6px', full: '999px' } as const;

/** The horizon bands in order, top to bottom, by token. */
export const SKY = ['sky-zenith', 'sky-veil', 'sky-glow', 'sky-horizon', 'sky-field'] as const;

const tokens = (p: Palette) => (Object.keys(p) as (keyof Palette)[]).map((k) => `--${k}:${p[k]}`);

/** One theme's colors as CSS declarations, `--surface:#16140f;…`, with its `color-scheme`. */
export function paletteCss(theme: Theme): string {
  return [...tokens(PALETTES[theme]), `color-scheme:${theme}`].join(';');
}

/** The declarations no theme changes: the faces and the radii. */
export function constantsCss(): string {
  return [
    ...(Object.keys(FONTS) as (keyof typeof FONTS)[]).map((k) => `--font-${k}:${FONTS[k]}`),
    ...(Object.keys(RADII) as (keyof typeof RADII)[]).map((k) => `--r-${k}:${RADII[k]}`),
  ].join(';');
}

/**
 * The tokens as a style sheet: Predawn on `:root`; Daybreak where the system prefers light, unless
 * the page says `data-theme="dark"`; and Daybreak where the page says `data-theme="light"`. A page
 * with no theme switch gets the same sheet, and follows the system.
 */
export function themeCss(): string {
  return [
    `:root{${paletteCss('dark')};${constantsCss()}}`,
    `@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${paletteCss('light')}}}`,
    `:root[data-theme="light"]{${paletteCss('light')}}`,
  ].join('\n');
}

/** The wordmark's geometry (brand/konjir-wordmark-on-dark.svg): its view box, the four monoline letters, the sun and the moon. */
export const WORDMARK = {
  viewBox: '0 0 122 56',
  width: 122,
  height: 56,
  strokeWidth: 3.4,
  letters: ['M4 6V40M16 21L4 32M8.5 28.5L17 40', 'M54 20V40M54 28a8 8 0 0 1 16 0V40', 'M98 20V40', 'M107 20V40M107 29a9 9 0 0 1 9 -9'],
  sun: { cx: 36, cy: 30, r: 11.7 },
  moon: 'M84.60 18.60 A20.33 20.33 0 0 1 76.40 52.40 A30.70 30.70 0 0 0 84.60 18.60Z',
} as const;

/**
 * The rules that color a wordmark drawn with `wordmarkSvg()` from the theme's tokens. A page whose
 * Content-Security-Policy allows only its own style sheet puts these in it: the SVG carries classes,
 * never a style attribute.
 */
export const WORDMARK_CSS = '.kj-wordmark .kj-ink{fill:none;stroke:var(--ink)}.kj-wordmark .kj-sun{fill:var(--sun)}.kj-wordmark .kj-moon{fill:var(--moon);stroke:var(--moon)}';

/**
 * The wordmark as inline SVG. By default its colors come from the page's tokens, through
 * WORDMARK_CSS; with `theme`, they are written into it, for a place with no style sheet (a file, an
 * email). `height` is in CSS pixels; the brand's minimum is 72px wide, which is a height of 33.
 */
export function wordmarkSvg(opts: { height?: number; theme?: Theme; label?: string } = {}): string {
  const height = opts.height ?? 40;
  const width = Math.round((height * WORDMARK.width / WORDMARK.height) * 100) / 100;
  const p = opts.theme ? PALETTES[opts.theme] : undefined;
  const ink = p ? ` fill="none" stroke="${p.ink}"` : '';
  const sun = p ? ` fill="${p.sun}"` : '';
  const moon = p ? ` fill="${p.moon}" stroke="${p.moon}"` : '';
  const label = opts.label ?? 'Konjir';
  return `<svg class="kj-wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="${WORDMARK.viewBox}" width="${width}" height="${height}" role="img" aria-label="${escapeHtml(label)}">`
    + `<g class="kj-ink"${ink} stroke-width="${WORDMARK.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${WORDMARK.letters.map((d) => `<path d="${d}"></path>`).join('')}</g>`
    + `<circle class="kj-sun"${sun} cx="${WORDMARK.sun.cx}" cy="${WORDMARK.sun.cy}" r="${WORDMARK.sun.r}"></circle>`
    + `<path class="kj-moon"${moon} d="${WORDMARK.moon}" stroke-width="0.6" stroke-linejoin="round"></path></svg>`;
}

/** The rule that draws the horizon as five bands across an element with class `kj-horizon`, top of the sky to the field. */
export const HORIZON_CSS = `.kj-horizon{display:flex;flex-direction:column;height:28px}.kj-horizon i{display:block}`
  + `.kj-horizon i:nth-child(1){flex:4;background:var(--sky-zenith)}.kj-horizon i:nth-child(2){flex:3;background:var(--sky-veil)}`
  + `.kj-horizon i:nth-child(3){flex:2;background:var(--sky-glow)}.kj-horizon i:nth-child(4){flex:2;background:var(--sky-horizon)}`
  + `.kj-horizon i:nth-child(5){flex:3;background:var(--sky-field)}`;

/** The horizon bands' markup, for HORIZON_CSS: decoration, hidden from assistive technology. */
export const HORIZON_HTML = `<div class="kj-horizon" aria-hidden="true">${SKY.map(() => '<i></i>').join('')}</div>`;

/** Text made safe for HTML, in content and in attribute values. */
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * The style of a small page that stands alone, loads nothing and runs no script: the tokens, a
 * column with the wordmark above a card, and the horizon at the foot. Kolab's sign-in pages and the
 * CLI's sign-in page are both built on it, so one leads into the other without a change of face.
 * The faces fall back to the system's where Konjir's aren't installed, since nothing is loaded.
 */
export function standalonePageCss(): string {
  return [
    themeCss(),
    '*{box-sizing:border-box}',
    'html,body{margin:0;min-height:100%;background:var(--surface)}',
    'body{color:var(--ink);font:15px/1.6 var(--font-sans);display:flex;flex-direction:column;min-height:100vh}',
    // The wordmark's clear space is the height of its k's ascender on every side: 24px at 40px tall.
    '.kj-page{flex:1;width:100%;max-width:576px;margin:0 auto;padding:40px 24px 48px}',
    '.kj-brand{display:block;margin:0 0 28px}',
    'h1{font:400 30px/1.15 var(--font-display);letter-spacing:-0.01em;margin:0 0 6px;text-wrap:balance}',
    'p{margin:8px 0}.muted{color:var(--ink-muted)}',
    '.card{background:var(--surface-raised);border:1px solid var(--line);border-radius:var(--r-md);padding:20px;margin:16px 0}',
    'code{font-family:var(--font-mono);font-size:0.86em;color:var(--secondary);overflow-wrap:anywhere}',
    'a{color:var(--accent)}:focus-visible{outline:2px solid var(--focus);outline-offset:2px}',
    WORDMARK_CSS,
    HORIZON_CSS,
  ].join('\n');
}

/**
 * A standalone page, whole: `body` is trusted HTML, `title` is text. `css` is the page's one style
 * sheet, standalonePageCss() and whatever the page adds to it; whoever sends the page allows it by
 * its hash.
 */
export function standalonePage(opts: { title: string; body: string; css: string; lang?: string }): string {
  return `<!doctype html><html lang="${escapeHtml(opts.lang ?? 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="dark light"><title>${escapeHtml(opts.title)}</title><style>${opts.css}</style></head>`
    + `<body><main class="kj-page"><div class="kj-brand">${wordmarkSvg({ height: 40 })}</div>${opts.body}</main>${HORIZON_HTML}</body></html>`;
}
