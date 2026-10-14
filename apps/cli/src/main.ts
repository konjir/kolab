#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
