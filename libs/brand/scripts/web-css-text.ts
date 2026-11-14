import { themeCss } from '../src/index.js';

/** apps/web/src/brand.css, whole: generated, so it says so, and one declaration to a line for a diff a person can read. */
export const webCss = () => `/* Generated from @konjir/brand (libs/brand/src/index.ts) by npm run brand. Don't edit: change the tokens there. */\n`
  + `${themeCss().replace(/\{(?=--)/g, '{\n  ').replace(/;(?=--|color-scheme)/g, ';\n  ').replace(/(light|dark)\}/g, '$1;\n}').replace(/\}\}$/gm, '}\n}')}\n`;
