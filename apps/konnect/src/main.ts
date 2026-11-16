#!/usr/bin/env node
import { main } from './konnect.js';

main(process.argv.slice(2)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
