// Runs in each test file's module registry, so it tears down what that file opened: its servers
// and clients (closeAtEnd), then its Kolabs, then its databases. Test files register what they
// open instead of closing it in hooks of their own: Jest runs this afterAll before a file's own,
// so a server closed there would still be holding its Kolab and database here.
import { afterAll } from '@jest/globals';
import { closeOpened } from '@konjir/engine/testing';

// Longer than a test's 30 s: one file's teardown can stop a child server (up to 10 s before
// SIGKILL), close servers that wait on their streams, close Kolabs and drop databases. A hook that
// timed out would leave the rest running after the file's environment was gone.
afterAll(closeOpened, 60_000);
