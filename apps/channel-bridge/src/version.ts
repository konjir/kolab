import { readFileSync } from 'node:fs';

// The published konjir (apps/cli/scripts/package.mjs), which carries the bridge as `konjir bridge`, defines this as its version.
declare const KONJIR_VERSION: string | undefined;

/** The bridge's version: konjir's, when it runs inside the published konjir; else its package.json's (one level up from src/ and dist/ alike). */
export const VERSION: string = typeof KONJIR_VERSION === 'string' ? KONJIR_VERSION
  : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
