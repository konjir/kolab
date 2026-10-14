/**
 * The test server's start command still runs `tsx src/cli.ts serve` (deploy/terraform,
 * modules/kolab/userdata.sh.tftpl). This forwards to the CLI app so the start
 * command can stay as it is. W1.10 moves production to compiled output and removes it.
 */
import '../apps/cli/src/main.js';
