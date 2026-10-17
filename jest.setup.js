// Runs in each test file's module registry, so it tears down what that file opened: its servers
// and clients (closeAtEnd), then its Kolabs, then its databases. Test files register what they
// open instead of closing it in hooks of their own: Jest runs this afterAll before a file's own,
// so a server closed there would still be holding its Kolab and database here.
import { afterAll } from '@jest/globals';
import { closeOpened } from '@konjir/engine/testing';

afterAll(closeOpened);
