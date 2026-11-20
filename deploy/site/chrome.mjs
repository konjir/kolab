// The header every page of www.konjir.com shares, and the footer of a section without an artboard
// of its own, for deploy/site/build.mjs. Written as the artboard is, with inline styles, which the
// build moves into classes like any other.
//
// The header: the Konjir mark, linking to the org page (/); a switcher between the products
// (Kolab, konnect), the current one marked; the section's own links; the theme switch, which
// deploy/site/site.js runs; and on Kolab's pages, its "Sign in" and "Sign up with GitHub".

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** The Konjir mark, as the artboard draws it, in its two sizes. */
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

// The theme switch as the artboard's component renders it, dark first; site.js applies the stored
// or preferred theme before the page paints.
const THEME = `<div role="radiogroup" aria-label="Theme" class="kb line" style="--kb-h: 44px; --kb-line: var(--line-strong); padding: 0 4px; gap: 0; cursor: default;">
<button type="button" role="radio" class="tt" aria-label="Daybreak, the light theme" title="Daybreak" aria-checked="false" tabindex="-1" data-theme-choice="light"><svg viewBox="0 0 37 37" width="22" height="22" aria-hidden="true"><circle cx="18.5" cy="18.5" r="11.7" style="fill: var(--sun)"></circle></svg></button>
<button type="button" role="radio" class="tt" aria-label="Predawn, the dark theme" title="Predawn" aria-checked="true" tabindex="0" data-theme-choice="dark"><svg viewBox="65.5 17 37 37" width="22" height="22" aria-hidden="true"><path d="M84.60 18.60 A19.68 19.68 0 0 1 76.40 52.40 A29.60 29.60 0 0 0 84.60 18.60Z" stroke-width="0.6" stroke-linejoin="round" style="fill: var(--moon); stroke: var(--moon)"></path></svg></button>
</div>`;

/**
 * The header of a page at `path` in `section`. `links` are the section's own, each
 * { href, text, accent? }: a link to `path` itself is marked as the current page. The switcher's
 * entry for the section is marked as the current one, and as the current page only when no
 * section link is, so one link at most says "page".
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
<nav aria-label="Main" style="max-width: 1200px; margin: 0 auto; padding: 16px clamp(16px, 4vw, 48px); box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px;">
<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px 14px;">
<a href="/" aria-label="Konjir home"${path === '/' ? ' aria-current="page"' : ''} style="display: flex; align-items: center;">
${mark(88, 40)}
</a>
<div role="group" aria-label="Products" style="display: inline-flex; align-items: center; box-sizing: border-box; height: 44px; padding: 0 4px; gap: 2px; border: 1px solid var(--line-strong); border-radius: 22px 6.16px 17.6px 22px; white-space: nowrap; font-size: 15px;">
${PRODUCTS.map(product).join('\n')}
</div>
</div>
<div style="display: flex; flex-wrap: wrap; gap: 4px 20px; flex: 1 1 auto; font-size: 15px;">
${links.map(link).join('\n')}
</div>
${THEME}
${signIn ? `${SIGN_IN}\n` : ''}</nav>
</header>`;
}

/** The footer of a section with no artboard to take its own from: the mark, every product's pages, the line the artboard ends on. */
export function footer(links) {
  return `<footer style="border-top: 1px solid var(--line);">
<div style="max-width: 1200px; margin: 0 auto; padding: 40px clamp(16px, 4vw, 48px) 48px; box-sizing: border-box; display: flex; flex-wrap: wrap; gap: 24px 48px; align-items: flex-start; justify-content: space-between;">
<div style="display: flex; flex-direction: column; gap: 10px;">
${mark(72, 33)}
</div>
<nav aria-label="Footer" style="display: flex; flex-wrap: wrap; gap: 8px 28px; font-size: 14px;">
${links.map((l) => `<a href="${l.href}">${esc(l.text)}</a>`).join('\n')}
</nav>
<p style="margin: 0; font-size: 13px; line-height: 20px; color: var(--ink-muted); flex-basis: 100%;">© 2026 Konjir · www.konjir.com</p>
</div>
</footer>`;
}
