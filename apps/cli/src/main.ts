#!/usr/bin/env node
import { main } from './cli.js';

// A job's guard hook (konjir work guard) that fails denies, with 2, the only exit Claude Code blocks on.
const guarding = process.argv[2] === 'work' && process.argv[3] === 'guard';
main(process.argv.slice(2)).catch((e) => { console.error(String(e.message ?? e)); process.exit(guarding ? 2 : 1); });
