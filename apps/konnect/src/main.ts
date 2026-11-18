#!/usr/bin/env node
import { exitStatus } from './errors.js';
import { main } from './konnect.js';
import { printable } from './names.js';

// An error may carry the service's own words (a refusal): printed as text, never as terminal controls.
// The exit status says what happened (errors.ts): 2 a wrong command line, 3 not logged in, 4 refused, 5 --wait ran out.
main(process.argv.slice(2)).catch((e) => { console.error(printable(String(e?.message ?? e))); process.exit(exitStatus(e)); });
