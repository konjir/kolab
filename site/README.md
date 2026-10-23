# site/: konjir.com

The marketing site at `https://konjir.com` (D81). Its content is the `konjir-site` kolab (D15, D81). Until that kolab has W4.1 prototypes to publish from, it is the claude.ai artifact [Konjir Marketing Page](https://claude.ai/artifact/7CLh2TuhVwCxrFSvyzGw1W), and the files here are its deployable copy. Change the artifact, not these files, then rebuild them.

Everything here except this README is generated, and `terraform apply` publishes it (the `site` module; see *Marketing site* in the top-level README).

## Updating from the artifact

1. Save the artboard and its images. With the Artifact tool: `read` the artifact with `path: "project/Main.dc.html"`, then `read` with `path` set to each id the page names as `/_blob/<id>`. Each image is saved as `<id>.<ext>`; put them in one folder.
2. Build:

   ```
   node deploy/site/from-artifact.mjs <path/to/Main.dc.html> <image-folder>
   ```

   It replaces `index.html`, `404.html`, `robots.txt`, `favicon.svg` and `assets/`. It needs the network, to fetch the fonts.
3. Look at it: serve `site/` (for example `npx http-server site`) and check the page renders, the theme switch works, and the console shows no errors.
4. Commit and `terraform apply`.

## What the build changes

The artboard runs on the artifact's design runtime, which a static site can't load. `from-artifact.mjs`:

- drops the runtime (`support.js`, `<x-dc>`, `<helmet>`) and puts its component logic, the Daybreak/Predawn theme switch, in `deploy/site/site.js`: dark by default, then the stored choice (`localStorage` `konjir.theme`) or the system's preference, as the artifact does
- self-hosts the Google Fonts the page links (Fraunces, Instrument Sans and JetBrains Mono, latin and latin-ext; all under the SIL Open Font License)
- moves every inline `style` into a generated class, so the CSP needs no `'unsafe-inline'`
- names assets by content hash, so they can be cached for a year
- adds a viewport tag, a description (the hero's lead), the favicon (`brand/konjir-mark-tile.svg`), `robots.txt`, and `404.html` with the page's header and footer

It refuses an artboard that uses runtime features it doesn't handle (`<sc-for>`, `<sc-if>`, `<dc-import>`, unknown template holes or handlers), rather than guess.

The page has no form. People sign up with their GitHub account: "Sign up with GitHub" links to Kolab's sign-in and sign-up, `https://kolab.konjir.com/api/session/oauth/start` (D55), and "Sign in" to `https://kolab.konjir.com/`. Both are plain links, so the CSP needs no other source.
