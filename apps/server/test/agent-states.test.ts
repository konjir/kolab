// What running agents say they are doing (konjir_say_state), as the server keeps it in memory
// (AgentStates): best of several sessions, fresh for AGENT_STATE_FRESH_SECONDS, by (kolab, actor),
// cleared by gone and by the session ending, swept, and capped without evicting anyone's fresh one.
import { expect, test } from '@jest/globals';
import type { Kolab } from '@konjir/engine';
import { AGENT_STATE_FRESH_SECONDS, MAX_AGENT_STATES, type KolabEvent } from '@konjir/types';
import { AgentStates } from '../src/agent-states.js';

/** A store on a clock the test moves, with a Kolab that only delivers the events the test sends. */
function store() {
  const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
  const listeners: ((e: KolabEvent) => void)[] = [];
  const kolab = { onEvent: (fn: (e: KolabEvent) => void) => { listeners.push(fn); return () => undefined; } } as unknown as Kolab;
  const states = new AgentStates(kolab, { adminToken: null, agentStateClock: () => clock.now });
  states.onModuleInit();
  return { states, clock, send: (e: KolabEvent) => listeners.forEach((fn) => fn(e)), close: () => states.onModuleDestroy() };
}

test('the best fresh state of an agent\'s sessions wins: idle, then working, then running; each session\'s next call replaces its own', () => {
  const { states, close } = store();
  try {
    states.say('s1', 'ann-claude', 'hub', 'running');
    expect(states.stateOf('hub', 'ann-claude')).toBe('running');
    states.say('s2', 'ann-claude', 'hub', 'working');
    expect(states.stateOf('hub', 'ann-claude')).toBe('working');
    states.say('s3', 'ann-claude', 'hub', 'idle');
    expect(states.stateOf('hub', 'ann-claude')).toBe('idle');
    states.say('s3', 'ann-claude', 'hub', 'running');
    expect(states.stateOf('hub', 'ann-claude')).toBe('working');
    states.say('s2', 'ann-claude', 'hub', 'gone');
    expect(states.stateOf('hub', 'ann-claude')).toBe('running');
    expect(states.size).toBe(2);
  } finally { close(); }
});

test('only the kolab and agent it was said for: another kolab, or another agent, reads null', () => {
  const { states, close } = store();
  try {
    states.say('s1', 'ann-claude', 'hub', 'idle');
    expect(states.stateOf('side', 'ann-claude')).toBeNull();
    expect(states.stateOf('hub', 'bo-claude')).toBeNull();
    expect(states.stateOf('hub', 'ann')).toBeNull();
  } finally { close(); }
});

test(`fresh for ${AGENT_STATE_FRESH_SECONDS} seconds; older reads null and is swept; a stale session doesn't hide a fresh one`, () => {
  const { states, clock, close } = store();
  try {
    states.say('old', 'ann-claude', 'hub', 'idle');
    clock.now += 60_000;
    states.say('new', 'ann-claude', 'hub', 'running');
    clock.now += (AGENT_STATE_FRESH_SECONDS - 60) * 1000 + 1;
    expect(states.stateOf('hub', 'ann-claude')).toBe('running');
    clock.now += 60_000;
    expect(states.stateOf('hub', 'ann-claude')).toBeNull();
    expect(states.size).toBe(2);
    states.sweep();
    expect(states.size).toBe(0);
  } finally { close(); }
});

test('a session ending, from this process or another, clears what it said, and no one else\'s', () => {
  const { states, send, close } = store();
  try {
    states.say('s1', 'ann-claude', 'hub', 'idle');
    states.say('s2', 'bo-claude', 'hub', 'working');
    send({ session: 'ended', id: 's1' } as KolabEvent);
    expect(states.stateOf('hub', 'ann-claude')).toBeNull();
    expect(states.stateOf('hub', 'bo-claude')).toBe('working');
    expect(states.size).toBe(1);
  } finally { close(); }
});

test(`at most ${MAX_AGENT_STATES} sessions: a new one past that is refused, stale ones are swept to make room, and no fresh one is evicted`, () => {
  const { states, clock, close } = store();
  try {
    for (let i = 0; i < MAX_AGENT_STATES; i++) states.say(`s${i}`, `a${i}`, 'hub', 'idle');
    expect(() => states.say('one-more', 'x', 'hub', 'idle')).toThrow(/LimitError|is full/);
    // A session already kept may still say it again.
    states.say('s0', 'a0', 'hub', 'working');
    expect(states.stateOf('hub', 'a0')).toBe('working');
    expect(states.stateOf('hub', `a${MAX_AGENT_STATES - 1}`)).toBe('idle');
    // Once they are stale, the next new one sweeps them and gets in.
    clock.now += (AGENT_STATE_FRESH_SECONDS + 1) * 1000;
    states.say('one-more', 'x', 'hub', 'idle');
    expect(states.size).toBe(1);
    expect(states.stateOf('hub', 'x')).toBe('idle');
  } finally { close(); }
});
