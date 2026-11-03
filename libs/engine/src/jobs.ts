/**
 * Jobs (W5.4a; D103, D104, JOB1–JOB3): what Kolab tells the headless agent a job runs, and the
 * small rules a job's rows follow. Pure: the engine reads the rows, and these decide. What a job's
 * agent is told is its kind's playbook (playbooks.ts; JOB7, D108).
 */
import { JOB_LIMITS, type JobEnd, type JobKind, type JobOutcome } from '@konjir/types';

/** The label of a person's `n`th pool agent (JOB3): `<person>-engineer-<n>`. */
export const poolLabel = (n: number) => `engineer-${n}`;

/**
 * A runner's machine label (JOB1), checked: 1 to JOB_LIMITS.machine characters, trimmed, with no
 * control characters, C0 or C1. It names the machine for people reading the ledger; it proves nothing.
 */
export function jobMachine(given: unknown): { machine?: string; problem?: string } {
  if (typeof given !== 'string' || !given.trim()) return { problem: `machine is a label for the machine the job runs on, 1 to ${JOB_LIMITS.machine} characters, such as lee-laptop` };
  const m = given.trim();
  if ([...m].length > JOB_LIMITS.machine) return { problem: `machine is ${[...m].length} characters; the limit is ${JOB_LIMITS.machine}` };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(m)) return { problem: 'machine holds a control character: give a plain label, such as lee-laptop' };
  return { machine: m };
}

/**
 * How a job ended (JOB1), from what became of its item and what its runner said: `submitted`, its
 * build's package submitted by its agent; `reviewed`, its agent gave the review; otherwise its item
 * went back to the queue, `stopped` if the runner stopped it and `released` if the agent finished
 * or failed without doing it. A lapse is Kolab's, and says `lapsed` whatever happened.
 */
export function jobOutcome(kind: JobKind, did: boolean, said: JobEnd): JobOutcome {
  if (did) return kind === 'build' ? 'submitted' : 'reviewed';
  return said === 'stopped' ? 'stopped' : 'released';
}
