#!/usr/bin/env node
import { main } from './channel.js';

main().catch((e) => { process.stderr.write(`konjir channel: ${String(e?.message ?? e)}\n`); process.exit(1); });
