import { defineConfig } from 'vite';
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

export default defineConfig({
  plugins: [react()],
  // @konjir/types is read from its TypeScript source, as the rest of the workspace reads it.
  resolve: { conditions: ['@konjir/source'] },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: { proxy: { '/api': proxy } },
});
