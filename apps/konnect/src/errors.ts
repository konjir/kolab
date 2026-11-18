/**
 * What a konnect command exits with, so a script can tell what happened without reading words:
 *
 *   0  done
 *   1  it failed: the service couldn't be reached, or answered with an error
 *   2  the command line was wrong, or named no action; nothing was done
 *   3  not logged in, or the login has lapsed
 *   4  refused: not allowed, or what was named doesn't exist
 *   5  --wait ran out with nothing received
 */
import { Refused, SignInError } from './client.js';

/** The command line was wrong, or named no action: nothing was done. */
export class UsageError extends Error {}

/** `--wait` ran out with nothing received. */
export class WaitRanOut extends Error {}

/** A command that would open the browser, run where there is no terminal to say so. */
export class NoTerminal extends SignInError {}

/**
 * `konnect wake` found a message for the agent: its notice is the error's words. A harness's hook
 * takes exit status 2 with words on standard error as what wakes its idle session.
 */
export class Woke extends Error {}

/** The exit status for what a command threw. */
export function exitStatus(e: unknown): number {
  if (e instanceof UsageError || e instanceof Woke) return 2;
  if (e instanceof SignInError) return 3;
  if (e instanceof Refused) return 4;
  if (e instanceof WaitRanOut) return 5;
  return 1;
}
