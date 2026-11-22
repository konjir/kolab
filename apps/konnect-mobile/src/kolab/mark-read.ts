/**
 * Marking a conversation read as it scrolls (S2), tried again a few times when Kolab can't be told,
 * even if nothing scrolls. One at a time; a call while one is under way is remembered, and what was
 * last on screen is what a retry marks. It stops for good once disposed (the screen closed), and
 * gives up on a sign-in that moved to another team or ended: those are never retried.
 */
import { SignedOut, TeamChanged } from '@/auth/tokens';

export interface MarkReader<T> {
  /** Marks read what `visible` shows (a scroll); a retry of an earlier failure is cancelled. */
  run(visible: T): void;
  /** No more marking and no more retries: the screen is gone. */
  dispose(): void;
}

export function markReader<T>(mark: (visible: T) => Promise<void>, o: { delayMs?: number; tries?: number } = {}): MarkReader<T> {
  const delayMs = o.delayMs ?? 5_000;
  const tries = o.tries ?? 3;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let disposed = false;
  let latest: T | undefined;
  let waiting = false;

  const attempt = async (n: number): Promise<void> => {
    if (disposed) return;
    if (busy) { waiting = true; return; }
    clearTimeout(timer);
    timer = undefined;
    busy = true;
    const visible = latest as T;
    let failed: unknown;
    try { await mark(visible); } catch (e) { failed = e ?? new Error('mark read failed'); } finally { busy = false; }
    if (disposed) return;
    if (waiting) { waiting = false; return attempt(0); }
    if (failed === undefined || failed instanceof TeamChanged || failed instanceof SignedOut || n + 1 >= tries) return;
    timer = setTimeout(() => { timer = undefined; void attempt(n + 1); }, delayMs);
  };

  return {
    run(visible) { latest = visible; void attempt(0); },
    dispose() { disposed = true; clearTimeout(timer); timer = undefined; },
  };
}
