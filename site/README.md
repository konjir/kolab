# site/: konjir.com

The marketing site at `https://konjir.com` (D81). Its source is here, in `site/src/` (D92, Lee's ruling of 2026-10-23):

- `src/project/Main.dc.html`: the artboard, on the claude.ai design runtime
- `src/images/<id>.<ext>`: each image the artboard names as `/_blob/<id>`
- `src/hands-on.md`: the hands-on tutorial, `https://konjir.com/hands-on/`, in the subset of Markdown that `deploy/site/markdown.mjs` renders

The tutorial lives only here. The artboard and its images are at the paths they have in the claude.ai artifact [Konjir Marketing Page](https://claude.ai/artifact/7CLh2TuhVwCxrFSvyzGw1W), which is published from `site/src/`. The artifact holds other files too, its `project/canvas.json` and the design system's tokens (`project/ds/…`): those stay in the artifact, aren't part of the source here, and a publish from `site/src/` keeps them, since files a publish leaves out are kept. The `konjir-site` kolab (D15) is still the page's future home; until it has W4.1 prototypes to publish from, this is the source.

Everything else here except this README is generated from `src/`, and `terraform apply` publishes it (the `site` module; see *Marketing site* in the top-level README). The module never uploads `src/` or this README. None of `site/` is in Kolab's release, so publishing the site alone doesn't reinstall Kolab.

## Changing the page

1. Edit `src/project/Main.dc.html`. Images live in `src/images/` as `<id>.<ext>` and the artboard names each as `/_blob/<id>`, where `<id>` is the 32 hex digits of its id in the artifact's asset store. A new image gets its id by being uploaded there (below).
2. Build:

   ```
   node deploy/site/build.mjs
   ```

   With no arguments it reads `site/src/project/Main.dc.html` and `site/src/images/`; `node deploy/site/build.mjs <Main.dc.html> <image-folder>` reads others. It always reads `site/src/hands-on.md`. It rewrites `index.html`, `404.html`, `hands-on/index.html`, `robots.txt`, `favicon.svg` and the files in `assets/`, and never touches `src/` or this README. It reads nothing from the network. It keeps the hashed assets that `origin/main`'s pages use (at the merge base with it), and those of every commit since on the branch, so a page cached just before a deploy still finds them and rebuilding a committed build changes nothing; it removes older ones. Without an `origin/main` it keeps HEAD's. CI's *Test on PGlite* rebuilds and fails if anything in `site/` changes or is added, so commit the build with the source.
3. Look at it: serve `site/` (for example `npx http-server site`) and check the page renders, the theme switch works, and the console shows no errors.
4. Commit the source and the build together, then `terraform apply`.

## Publishing the artifact

The artifact follows the repository. To publish it after a change, use the Artifact tool's `publish` with `url` the artifact (`https://claude.ai/artifact/7CLh2TuhVwCxrFSvyzGw1W`), `root` `site/src` and `file_path` the absolute path of `site/src/project/Main.dc.html`. A new image is uploaded first, with `publish`, `url` the artifact, `asset: true` and `file_path` the image; name it in the artboard by the `url` the result gives, `/_blob/<id>`, and save it in `src/images/` as `<id>.<ext>`.

If someone edits the artifact on claude.ai, read it back into `site/src/` before building, or the next publish overwrites their change: `read` the artifact with `path: "project/Main.dc.html"` and save it over `src/project/Main.dc.html`, then `read` each new `/_blob/<id>` with `path: "<id>"` and `out_dir` `site/src/images`. Then build and commit as above.

## What the build changes

The artboard runs on the artifact's design runtime, which a static site can't load. `build.mjs`:

- drops the runtime (`support.js`, `<x-dc>`, `<helmet>`) and puts its component logic, the Daybreak/Predawn theme switch, in `deploy/site/site.js`: dark by default, then the stored choice (`localStorage` `konjir.theme`) or the system's preference, as the artifact does
- serves the fonts the page links (Fraunces, Instrument Sans and JetBrains Mono, latin and latin-ext) from the copy vendored in `deploy/site/fonts/`, after checking each file against `source.json`, and ships each family's SIL Open Font License beside them, as `assets/fonts/<family>-OFL.txt`. If the artboard's font link changes, the build refuses until you run `node deploy/site/vendor-fonts.mjs '<the new link>'`
- moves every inline `style` into a generated class, so the CSP needs no `'unsafe-inline'`
- names assets by content hash, so they can be cached for a year
- adds a viewport tag, a description (the hero's lead), the favicon (`brand/konjir-mark-tile.svg`), `robots.txt`, and `404.html` with the page's header and footer
- renders `src/hands-on.md` into `hands-on/index.html`, inside the same header and footer (their in-page links pointing home), with a contents list of its `##` headings, its first paragraph as its description, and `deploy/site/article.css` added to the shared stylesheet. `markdown.mjs` renders only what the tutorial uses: `#`, `##` and `###` headings, paragraphs, `-` and `1.` lists, tables, fenced code blocks of the kinds `sh`, `text` (a prompt to paste), `output` and `file`, and inline code, bold and links to `https://`, `/` or `#` (holding no `\`, `(` or `)`). It escapes all text, the title included, and refuses anything else, raw HTML included, rather than guess. Each finished page is then checked whole: its `<head>` must be exactly the one the build writes, and its body must pass the same refusals as the artboard. The site's CloudFront Function serves `/hands-on/` from `hands-on/index.html` and sends `/hands-on` there

It refuses, rather than guess, an artboard that uses runtime features it doesn't handle (`<sc-for>`, `<sc-if>`, `<dc-import>`, unknown template holes) or anything the CSP would block: event handler attributes in any case, `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>` or `<form>` in the body, `javascript:` URLs, resources from anywhere but the site itself, and a `style` holding `url()`, `@import` or a brace.

The page has no form. People sign up with their GitHub account: "Sign up with GitHub" links to Kolab's sign-in and sign-up, `https://kolab.konjir.com/api/session/oauth/start` (D55), and "Sign in" to `https://kolab.konjir.com/`. Both are plain links, so the CSP needs no other source.
