// Runs in each test file's module registry, so it tears down what that file opened: its servers
// and clients (closeAtEnd), then its Kolabs, then its databases. Test files register what they
// open instead of closing it in hooks of their own: Jest runs this afterAll before a file's own,
// so a server closed there would still be holding its Kolab and database here.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach } from '@jest/globals';
import { closeOpened, markOpened } from '@konjir/engine/testing';

// Never the sign-ins kept on this machine: konjir with no URL uses the one it keeps (D106), which
// may be a deployed Kolab's, and so may a KONJIR_CREDENTIALS exported in the shell, so it is
// replaced, not kept. A file that doesn't exist keeps none; a test that signs in names its own.
process.env.KONJIR_CREDENTIALS = join(tmpdir(), `konjir-test-${process.pid}-none`, 'credentials.json');

// Each test's own servers, clients, Kolabs and databases close when it ends, not when the file
// does: a PGlite Kolab holds hundreds of megabytes, and a file of a few dozen tests that kept them
// all ran CI's runner out of memory. What the file opens outside a test closes when it ends.
// Longer than a test's 30 s: a teardown can stop a child server (up to 10 s before SIGKILL),
// close servers that wait on their streams, close Kolabs and drop databases. A hook that timed out
// would leave the rest running after the file's environment was gone.
let mark;
beforeEach(() => { mark = markOpened(); });
afterEach(() => closeOpened(mark), 60_000);
afterAll(closeOpened, 60_000);
