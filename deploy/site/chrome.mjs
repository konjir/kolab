// The root and the header every page of www.konjir.com shares, and the footer of a section without
// a footer.html of its own, for deploy/site/build.mjs. Written as the pages in site/src/ are, with
// inline styles, which the build moves into classes like any other.
//
// The root: the .kj element that holds the page and the theme's colours (site/src/site.css), written
// dark (Predawn); site.js applies the stored or preferred theme before the page paints.
//
// The header: the Konjir mark, linking to the org page (/); a switcher between the products
// (Kolab, konnect), the current one marked; and a menu holding the section's own links, the theme
// switch, which deploy/site/site.js runs, and on Kolab's pages, its "Sign in" and "Sign up with
// GitHub". The footer ends with the source and licences (SOURCE_NAV).

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** The opening tag of every page's root; the build closes it after the footer. */
export const ROOT = `<div class="kj" data-theme="dark" style="background: var(--surface); color: var(--ink); font-family: 'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 16px; line-height: 26px; min-width: 0;">`;

/** The Konjir mark, in its two sizes. */
const mark = (width, height) => `<svg viewBox="0 0 122 56" width="${width}" height="${height}" role="img" aria-label="Konjir">
<g fill="none" style="stroke: var(--ink)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6V40M16 21L4 32M8.5 28.5L17 40"></path><path d="M54 20V40M54 28a8 8 0 0 1 16 0V40"></path><path d="M98 20V40"></path><path d="M107 20V40M107 29a9 9 0 0 1 9 -9"></path></g>
<circle cx="36" cy="30" r="11.7" style="fill: var(--sun)"></circle>
<path d="M84.60 18.60 A19.68 19.68 0 0 1 76.40 52.40 A29.60 29.60 0 0 0 84.60 18.60Z" style="fill: var(--moon); stroke: var(--moon)" stroke-width="0.6" stroke-linejoin="round"></path>
</svg>`;

/** The products the switcher offers, each the section it leads to. */
export const PRODUCTS = [
  { section: 'kolab', name: 'Kolab', href: '/kolab/' },
  { section: 'konnect', name: 'konnect', href: '/konnect/' },
];

const SIGN_IN = `<a href="https://kolab.konjir.com/" style="font-size: 15px;">Sign in</a>
<a href="https://kolab.konjir.com/api/session/oauth/start" class="kb fill" style="--kb-h: 44px; --kb-fill: var(--accent); --kb-line: var(--accent); padding: 0 22px; color: var(--on-accent); font-weight: 600; font-size: 15px;">Sign up with GitHub</a>`;

// The theme switch, a radio group, written dark first; site.js applies the stored or preferred
// theme before the page paints, and keeps the radios in step with it.
const THEME = `<div role="radiogroup" aria-label="Theme" class="kb line" style="--kb-h: 44px; --kb-line: var(--line-strong); padding: 0 4px; gap: 0; cursor: default;">
<button type="button" role="radio" class="tt" aria-label="Daybreak, the light theme" title="Daybreak" aria-checked="false" tabindex="-1" data-theme-choice="light"><svg viewBox="0 0 37 37" width="22" height="22" aria-hidden="true"><circle cx="18.5" cy="18.5" r="11.7" style="fill: var(--sun)"></circle></svg></button>
<button type="button" role="radio" class="tt" aria-label="Predawn, the dark theme" title="Predawn" aria-checked="true" tabindex="0" data-theme-choice="dark"><svg viewBox="65.5 17 37 37" width="22" height="22" aria-hidden="true"><path d="M84.60 18.60 A19.68 19.68 0 0 1 76.40 52.40 A29.60 29.60 0 0 0 84.60 18.60Z" stroke-width="0.6" stroke-linejoin="round" style="fill: var(--moon); stroke: var(--moon)"></path></svg></button>
</div>`;

// The menu button's icon: three bars, and a cross while the menu is open (the stylesheet shows one).
const MENU_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path class="menu-bars" d="M3 5.5H17M3 10H17M3 14.5H17"></path><path class="menu-x" d="M5 5L15 15M15 5L5 15"></path></svg>`;

/**
 * The header of a page at `path` in `section`. `links` are the section's own, each
 * { href, text, accent? }: a link to `path` itself is marked as the current page. The switcher's
 * entry for the section is marked as the current one, and as the current page only when no
 * section link is, so one link at most says "page".
 *
 * The section's links, the theme switch and the sign-in are in a <details>, the menu. On a wide
 * screen the stylesheet (site/src/site.css) lays them out in the header's one row and hides
 * the menu's summary; on a narrow one the row is the mark, the switcher and the summary, the menu
 * button, and they open beneath it. It opens and closes with no script; site.js keeps it open on a
 * wide screen, and closes it on Escape, a click outside it, or focus leaving it.
 */
export function header({ section, path, links, signIn }) {
  const linked = links.some((l) => l.href === path);
  const product = (p) => {
    const here = p.section === section;
    const current = here ? ` aria-current="${p.href === path && !linked ? 'page' : 'true'}"` : '';
    const style = `display: inline-flex; align-items: center; height: 34px; padding: 0 10px; border-radius: 999px;${here ? ' background: var(--accent-soft); color: var(--accent); font-weight: 600;' : ''}`;
    return `<a href="${p.href}"${current} style="${style}">${esc(p.name)}</a>`;
  };
  const link = (l) => {
    const current = l.href === path ? ' aria-current="page"' : '';
    const style = l.accent ? ' style="color: var(--accent); font-weight: 600;"' : l.href === path ? ' style="font-weight: 600;"' : '';
    return `<a href="${l.href}"${current}${style}>${esc(l.text)}</a>`;
  };
  return `<header style="border-bottom: 1px solid var(--line);">
<nav aria-label="Main" class="hd" style="max-width: 1200px; margin: 0 auto; padding: 16px clamp(16px, 4vw, 48px); box-sizing: border-box;">
<div class="hd-brand">
<a href="/" aria-label="Konjir home"${path === '/' ? ' aria-current="page"' : ''} style="display: flex; align-items: center;">
${mark(88, 40)}
</a>
<div role="group" aria-label="Products" style="display: inline-flex; align-items: center; box-sizing: border-box; height: 44px; padding: 0 4px; gap: 2px; border: 1px solid var(--line-strong); border-radius: 22px 6.16px 17.6px 22px; white-space: nowrap; font-size: 15px;">
${PRODUCTS.map(product).join('\n')}
</div>
</div>
<details class="menu" data-menu="">
<summary class="kb line">${MENU_ICON}<span class="menu-label">Menu</span></summary>
<div class="menu-panel">
<div class="menu-links">${links.length ? `\n${links.map(link).join('\n')}\n` : ''}</div>
<div class="menu-end">
${THEME}
${signIn ? `${SIGN_IN}\n` : ''}</div>
</div>
</details>
</nav>
</header>`;
}

/**
 * Where the source, the packages and their licences are: every footer's, site/src/kolab/footer.html's
 * included (it writes this nav as it is here; a test holds them equal). Kolab's server, the rest of
 * the repository, is FSL-1.1-ALv2 (LICENSE.md); the CLIs, kolab and konnect, are Apache-2.0, each
 * with its LICENSE (README.md, Licence). There is no privacy policy or terms yet, and the
 * repository names no contact, so neither is linked.
 */
export const SOURCE_LINKS = [
  { href: 'https://github.com/konjir/kolab', text: 'GitHub' },
  { href: 'https://github.com/konjir/kolab/tree/main/apps/server', text: 'Kolab server source' },
  { href: 'https://github.com/konjir/kolab/tree/main/apps/konnect-mobile', text: 'konnect app source' },
  { href: 'https://www.npmjs.com/package/@konjir/kolab', text: '@konjir/kolab on npm' },
  { href: 'https://www.npmjs.com/package/@konjir/konnect', text: '@konjir/konnect on npm' },
  { href: 'https://github.com/konjir/kolab/blob/main/LICENSE.md', text: 'Kolab server licence (FSL-1.1-ALv2)' },
  { href: 'https://github.com/konjir/kolab/blob/main/apps/cli/LICENSE', text: 'kolab CLI licence (Apache-2.0)' },
  { href: 'https://github.com/konjir/kolab/blob/main/apps/konnect/LICENSE', text: 'konnect licence (Apache-2.0)' },
  { href: '/privacy/', text: 'Privacy' },
];
export const SOURCE_NAV = `<nav aria-label="Source and licences" style="display: flex; flex-wrap: wrap; gap: 8px 24px; font-size: 13px; line-height: 20px; flex-basis: 100%;">
${SOURCE_LINKS.map((l) => `<a href="${l.href}">${esc(l.text)}</a>`).join('\n')}
</nav>`;

/** The footer of a section with no footer.html of its own: the mark, every product's pages, the source and licences, and the copyright line. */
export function footer(links) {
  return `<footer style="border-top: 1px solid var(--line);">
<div style="max-width: 1200px; margin: 0 auto; padding: 40px clamp(16px, 4vw, 48px) 48px; box-sizing: border-box; display: flex; flex-wrap: wrap; gap: 24px 48px; align-items: flex-start; justify-content: space-between;">
<div style="display: flex; flex-direction: column; gap: 10px;">
${mark(72, 33)}
</div>
<nav aria-label="Footer" style="display: flex; flex-wrap: wrap; gap: 8px 28px; font-size: 14px;">
${links.map((l) => `<a href="${l.href}">${esc(l.text)}</a>`).join('\n')}
</nav>
${SOURCE_NAV}
<p style="margin: 0; font-size: 13px; line-height: 20px; color: var(--ink-muted); flex-basis: 100%;">© 2026 Konjir · www.konjir.com</p>
</div>
</footer>`;
}
