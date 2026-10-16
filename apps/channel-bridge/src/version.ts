import { readFileSync } from 'node:fs';

/** The bridge's version, from its package.json (one level up from src/ and dist/ alike). */
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
