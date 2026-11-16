#!/usr/bin/env node
import { main } from './konnect.js';
import { printable } from './names.js';

// An error may carry Kolab's own words (a refusal): printed as text, never as terminal controls.
main(process.argv.slice(2)).catch((e) => { console.error(printable(String(e?.message ?? e))); process.exit(1); });
