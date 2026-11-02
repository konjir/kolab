// Writes docs/verbs.md (W5.7): every verb Kolab serves, with its parameters, from the schemas. `npm run verbs`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { servedTools, verbsMarkdown } from '../src/verbs.js';

const out = fileURLToPath(new URL('../../../docs/verbs.md', import.meta.url));
writeFileSync(out, verbsMarkdown(await servedTools()));
console.log(`wrote ${out}`);
