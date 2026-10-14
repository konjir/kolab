// Runs in each test file's module registry, so it closes the databases that file opened.
import { afterAll } from '@jest/globals';
import { closeOpened } from '@konjir/engine/testing';

afterAll(closeOpened);
