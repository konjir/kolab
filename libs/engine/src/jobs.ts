/**
 * Jobs (W5.4a, W5.11; D103, D104, D108, JOB1–JOB3, JOB6): what Kolab tells the headless agent a job runs, and the
 * small rules a job's rows follow. Pure: the engine reads the rows, and these decide. What a job's
 * agent is told is its kind's playbook (playbooks.ts; JOB7, D108).
 */
import { JOB_KINDS, JOB_LIMITS, type JobEnd, type JobKind, type JobOutcome } from '@konjir/types';

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
 * The kinds a take may start when its runner names none (JOB6): build and review, the kinds every
 * `konjir work` knows, so a runner from before W5.11 never gets an item it has no playbook for.
 */
export const DEFAULT_TAKE_KINDS: readonly JobKind[] = ['build', 'review'];

/** The kinds of item a runner takes (konjir_take_job's kinds), checked: a list of JOB_KINDS, at least one; by default DEFAULT_TAKE_KINDS. */
export function jobKinds(given: unknown): { kinds?: JobKind[]; problem?: string } {
  if (given === undefined || given === null) return { kinds: [...DEFAULT_TAKE_KINDS] };
  const known = (k: unknown): k is JobKind => (JOB_KINDS as readonly unknown[]).includes(k);
  if (!Array.isArray(given) || !given.length || !given.every(known)) return { problem: `kinds lists the kinds of item this runner takes, at least one of ${JOB_KINDS.join(', ')}` };
  return { kinds: [...new Set(given)] };
}

/**
 * What a job's agent did of its item (JOB1, JOB6), as the engine reads it: nothing (false); its
 * item done (true); or, for a mark job, which way it settled the mark: `cleared` it, or `redrafted`
 * the marked node and submitted that version for review.
 */
export type JobDid = boolean | 'cleared' | 'redrafted';

/**
 * How a job ended (JOB1, JOB6), from what became of its item and what its runner said. Done:
 * `submitted`, a build's package submitted by its agent, a mark job's redraft or a serve job's
 * binding version submitted for review; `reviewed`, a review given; `answered`, an answer job's
 * question answered or note replied to; `cleared`, a mark job's mark cleared. Otherwise its item
 * went back to the queue, `stopped` if the runner stopped it and `released` if the agent finished
 * or failed without doing it: for a question, a mark or a spec element, a hand-off to a person,
 * the runner's note saying what they must decide. A lapse is Kolab's, and says `lapsed` whatever happened.
 */
export function jobOutcome(kind: JobKind, did: JobDid, said: JobEnd): JobOutcome {
  if (did) {
    if (kind === 'review') return 'reviewed';
    if (kind === 'answer') return 'answered';
    return did === 'cleared' ? 'cleared' : 'submitted';
  }
  return said === 'stopped' ? 'stopped' : 'released';
}

/** The outcomes that say a job did its item (JOB2): the rest, ended in the last hour, hold the item back. */
export const DID_OUTCOMES: readonly JobOutcome[] = ['submitted', 'reviewed', 'answered', 'cleared'];
