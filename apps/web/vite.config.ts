import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web interface (W3.1). `vite build` writes dist/, which Kolab serves at its root
 * (apps/server/src/web/static.ts). `vite` serves it with hot reload and proxies Kolab's own
 * routes to a Kolab on 127.0.0.1:7420 (KONJIR_WEB_PROXY to change it), as that Kolab's origin,
 * since the API accepts changes only from Kolab's own pages.
 */
const target = process.env.KONJIR_WEB_PROXY ?? 'http://127.0.0.1:7420';
const proxy = {
  target, changeOrigin: true,
  configure: (p: { on(e: 'proxyReq', fn: (r: { setHeader(k: string, v: string): void }) => void): void }) =>
    p.on('proxyReq', (r) => r.setHeader('origin', target)),
};

/** Fonts, which the page's Content-Security-Policy (`font-src 'self'`, apps/server/src/web/static.ts) loads only as files. */
const FONT = /\.(woff2?|ttf|otf|eot)$/i;

/** Fails the build if a stylesheet still carries a font inline, which that policy would block. */
const noInlineFonts = (): Plugin => ({
  name: 'konjir:no-inline-fonts',
  generateBundle(_, bundle) {
    for (const f of Object.values(bundle)) {
      if (f.type === 'asset' && f.fileName.endsWith('.css') && /data:(font\/|application\/(x-)?font)/.test(String(f.source))) {
        this.error(`${f.fileName} inlines a font as a data: URI, which font-src 'self' blocks. Serve it as a file.`);
      }
    }
  },
});

export default defineConfig({
  plugins: [react(), noInlineFonts()],
  // @konjir/types is read from its TypeScript source, as the rest of the workspace reads it.
  resolve: { conditions: ['@konjir/source'] },
  build: {
    outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022',
    // Vite inlines small assets as data: URIs; a font must stay a file of Kolab's own (font-src 'self').
    assetsInlineLimit: (file) => (FONT.test(file) ? false : undefined),
  },
  server: { proxy: { '/api': proxy } },
});
