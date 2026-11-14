// Writes apps/web/src/brand.css from the tokens (npm run brand). The web page's policy allows only
// style sheets Kolab serves as files, so its tokens are a file, generated here and committed;
// libs/brand's tests fail when it no longer says what the tokens say.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webCss } from './web-css-text.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'src', 'brand.css');
writeFileSync(out, webCss());
console.log(`wrote ${out}`);
