// A small Markdown renderer for konjir.com's article pages (the hands-on tutorial, site/src/hands-on.md).
// It renders only the subset those pages use, and refuses anything else rather than guess, so a page
// never ships something the site's CSP or the build's rules (deploy/site/build.mjs) would object to:
//
//  - headings: one "# " title, then "## " and "### " (each gets an id from its text, for links)
//  - paragraphs, "- " lists and "1. " lists, a line each item (a list item's text may wrap onto
//    following lines)
//  - tables: a header row, a "| --- |" row, then rows, every row starting and ending with "|"
//  - fenced code blocks, ``` followed by one of CODE_KINDS, which names the box's label
//  - inline: `code`, **bold** and [text](https://… or /… or #…)
//
// All text is escaped; raw HTML is never passed through. No dependency, no network: the build stays
// offline and deterministic.

/** The kinds of fenced block, and the label each box shows. */
export const CODE_KINDS = { sh: 'Terminal', text: 'Prompt', output: 'What you see', file: 'File' };

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** An id for a heading: its words, lowercased, joined by '-'. */
export const slug = (text) =>
  text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function inline(text, fail) {
  // Code spans first: their insides are only escaped, and set aside (as \u0000<n>\u0000) while the
  // rest is rendered, so bold may hold a code span but nothing reads inside one.
  if (text.includes('\u0000')) fail('a NUL character');
  const spans = [];
  let s = text.replace(/`([^`]+)`/g, (_, code) => `\u0000${spans.push(`<code>${esc(code)}</code>`) - 1}\u0000`);
  if (s.includes('`')) fail(`an unclosed code span: ${text.slice(0, 60)}`);
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    if (!/^(https:\/\/|\/(?!\/)|#)/.test(href)) fail(`a link to ${href}: only https://, /path and #anchor links`);
    return `<a href="${href}">${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  if (/\*|\[[^\]]*\]\(/.test(s)) fail(`Markdown this renderer doesn't handle: ${text.slice(0, 60)}`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => spans[Number(n)]);
}

/**
 * Renders `md`. Returns the title (the "# " heading's text), its HTML, the first paragraph as plain
 * text (the page's description), the "## " headings for a table of contents, and the body's HTML.
 */
export function render(md, fail = (m) => { throw new Error(m); }) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let title = null;
  let lead = null;
  let i = 0;
  const id = (text) => {
    const base = slug(text) || 'section';
    let v = base;
    for (let n = 2; ids.has(v); n++) v = `${base}-${n}`;
    ids.add(v);
    return v;
  };
  const blank = (l) => l.trim() === '';
  const startsBlock = (l) => /^(#{1,6} |```|\| |- |\d+\. )/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) { i++; continue; }

    const h = /^(#{1,6}) (.+)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const html = inline(h[2].trim(), fail);
      if (level === 1) {
        if (title !== null) fail('a second "# " title');
        if (out.length) fail('the "# " title must come first');
        title = { text: h[2].trim(), html };
      } else if (level === 2 || level === 3) {
        if (title === null) fail('a heading before the "# " title');
        const hid = id(html);
        out.push(`<h${level} id="${hid}">${html}</h${level}>`);
        if (level === 2) toc.push({ id: hid, html });
      } else fail(`a level-${level} heading; use ## or ###`);
      i++;
      continue;
    }

    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const kind = fence[1].trim();
      if (!Object.hasOwn(CODE_KINDS, kind)) fail(`a code block of kind "${kind}"; give one of ${Object.keys(CODE_KINDS).join(', ')}`);
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== '```') body.push(lines[i++]);
      if (i >= lines.length) fail('an unclosed code block');
      i++;
      out.push(`<figure class="code ${kind}"><figcaption>${CODE_KINDS[kind]}</figcaption><pre><code>${esc(body.join('\n'))}</code></pre></figure>`);
      continue;
    }

    if (line.startsWith('| ')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => {
        if (!/^\|.*\|$/.test(r.trim())) fail(`a table row that doesn't end with |: ${r.slice(0, 60)}`);
        return r.trim().slice(1, -1).split('|').map((c) => c.trim());
      };
      if (rows.length < 2 || !cells(rows[1]).every((c) => /^-{3,}$/.test(c))) fail('a table without a "| --- |" row under its header');
      const head = cells(rows[0]);
      const tr = (cs, tag) => `<tr>${cs.map((c) => `<${tag}>${inline(c, fail)}</${tag}>`).join('')}</tr>`;
      const body = rows.slice(2).map((r) => {
        const cs = cells(r);
        if (cs.length !== head.length) fail(`a table row with ${cs.length} cells, not ${head.length}`);
        return tr(cs, 'td');
      });
      out.push(`<div class="table"><table><thead>${tr(head, 'th')}</thead><tbody>${body.join('')}</tbody></table></div>`);
      continue;
    }

    const item = /^(- |\d+\. )/.exec(line);
    if (item) {
      const ordered = item[1] !== '- ';
      const items = [];
      while (i < lines.length && /^(- |\d+\. )/.test(lines[i])) {
        const marker = /^(- |\d+\. )/.exec(lines[i])[1];
        if ((marker !== '- ') !== ordered) fail('a list that mixes "- " and "1. " items');
        let text = lines[i].slice(marker.length);
        i++;
        while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) text += ` ${lines[i++].trim()}`;
        items.push(`<li>${inline(text, fail)}</li>`);
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (/^\s|^>|^<|^\*/.test(line)) fail(`a line this renderer doesn't handle: ${line.slice(0, 60)}`);
    const para = [line];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i])) para.push(lines[i++]);
    const html = inline(para.join(' '), fail);
    if (lead === null) lead = html.replace(/<[^>]+>/g, '');
    out.push(`<p>${html}</p>`);
  }
  if (title === null) fail('no "# " title');
  return { title, lead: lead ?? fail('no paragraph for the description'), toc, html: out.join('\n') };
}
