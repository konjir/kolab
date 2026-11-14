import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Claude Code starts the bridge in the project. @onivoro/server-mcp, as it loads, looks up
// @nestjs/core/package.json from the working folder, and would run one a project shipped as a
// folder of code (the review of #144). So the bridge's packages load from the bridge's own folder,
// in this checkout, and the working folder is the project's again before anything else runs.
const project = process.cwd();
process.chdir(dirname(fileURLToPath(import.meta.url)));
const loading = import('./channel.js');
loading.finally(() => process.chdir(project)).then(({ main }) => main())
  .catch((e) => { process.stderr.write(`konjir channel: ${String(e?.message ?? e)}\n`); process.exit(1); });
