#!/usr/bin/env node
import { kolabWords } from '@konjir/channel-bridge/words';
import { main } from './cli.js';

// A job's guard hook (kolab work guard) that fails denies, with 2, the only exit Claude Code blocks on.
const guarding = process.argv[2] === 'work' && process.argv[3] === 'guard';
// An error is said in kolab's words (words.ts): Kolab's and @konjir/login's still name `konjir login` and the like.
main(process.argv.slice(2)).catch((e) => { console.error(kolabWords(String(e.message ?? e))); process.exit(guarding ? 2 : 1); });
