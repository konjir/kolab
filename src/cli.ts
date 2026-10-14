/**
 * The test server's start command still runs `tsx src/cli.ts serve` (deploy/terraform,
 * modules/kolab/userdata.sh.tftpl). This forwards to the CLI app so W1.0 needs no
 * change to the instance. W1.10 moves production to compiled output and removes it.
 */
import { main } from '../apps/cli/src/cli.js';

main(process.argv.slice(2)).catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
