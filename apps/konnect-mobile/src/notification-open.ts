/**
 * Where a tapped notification is taking the person, until the team it is for is the one on screen.
 *
 * A tap for another team switches there first, and the switch resets the screens (the Gate, in
 * app/_layout.tsx, dismisses them all and replaces with Home), so a conversation opened before that
 * reset would be closed by it. So the target is kept here, and the Gate opens it once it has shown
 * the team, after its reset. A tap for the team already shown opens at once. A target that waits
 * longer than `TTL_MS` (its switch failed, or never came) is dropped rather than opened later by
 * surprise.
 */
export interface Target { team: string; path: string }

export const TTL_MS = 60_000;

let shown: string | undefined;
let pending: (Target & { at: number }) | undefined;

/**
 * A tap's target: true if it should open now (its team is the one on screen), false if it is kept
 * for the Gate to open once that team is shown.
 */
export function openOrKeep(to: Target, now = Date.now()): boolean {
  if (shown === to.team) { pending = undefined; return true; }
  pending = { ...to, at: now };
  return false;
}

/** The Gate has shown `team` (after any reset): the path a tap kept for it, once. */
export function teamShown(team: string | undefined, now = Date.now()): string | undefined {
  shown = team;
  const p = pending;
  if (!p || !team) return undefined;
  if (now - p.at > TTL_MS) { pending = undefined; return undefined; }
  if (p.team !== team) return undefined;
  pending = undefined;
  return p.path;
}

/** A tap's switch failed: its target is forgotten, unless a later tap replaced it. */
export function forget(to: Target) {
  if (pending && pending.team === to.team && pending.path === to.path) pending = undefined;
}
