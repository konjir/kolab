// Progress's rule (W8.7; WRK8, WRK6): a package's progress is its state; over what is counted, done
// when every one is, to do when every one is, otherwise in progress; what has no work is left out
// unless all is; at risk when any one counted is; a ruling is named by an element's Source line.
import { expect, test } from '@jest/globals';
import { packageProgress, progressOver, sourceRefs } from '@konjir/engine';
import type { Progress } from '@konjir/types';

const p = (progress: Progress['progress'], at_risk = false): Progress => ({ progress, at_risk });

test('a work package\'s progress is its own state: In review, approved or not, is in progress (WRK8)', () => {
  expect((['todo', 'in_progress', 'in_review', 'done'] as const).map(packageProgress)).toStrictEqual(['todo', 'in_progress', 'in_progress', 'done']);
});

test('over what is counted: done when all are, to do when all are, otherwise in progress; no work and not served left out unless all are; at risk when any counted is (WRK8, WRK6)', () => {
  expect(progressOver([])).toStrictEqual(p('no_work'));
  expect(progressOver([p('done'), p('done')])).toStrictEqual(p('done'));
  expect(progressOver([p('todo'), p('todo')])).toStrictEqual(p('todo'));
  expect(progressOver([p('todo'), p('done')])).toStrictEqual(p('in_progress'));
  expect(progressOver([p('in_progress')])).toStrictEqual(p('in_progress'));
  expect(progressOver([p('done'), p('no_work'), p('not_served')])).toStrictEqual(p('done'));
  expect(progressOver([p('no_work'), p('not_served')])).toStrictEqual(p('no_work'));
  expect(progressOver([p('done', true), p('todo')])).toStrictEqual(p('in_progress', true));
  // What is left out counts for nothing, at risk or not.
  expect(progressOver([p('done'), p('no_work', true)])).toStrictEqual(p('done'));
});

test('an element names a ruling in a line that starts with Source:, after any list marker; elsewhere, and in a range, it names none (WRK8, migration 0042)', () => {
  expect([...sourceRefs('Konjir is one service.\nSource: D12, D47.')]).toStrictEqual(['D12', 'D47']);
  expect([...sourceRefs('Orders can be cancelled.\n  - Source: D7; POL4 (D109)\nMore text, D8 not named.')]).toStrictEqual(['D7', 'POL4', 'D109']);
  expect([...sourceRefs('1. Source: D3')]).toStrictEqual(['D3']);
  // Not at a line's start: a sentence that mentions a source names nothing.
  expect([...sourceRefs('Konjir is one service. Source: D12')]).toStrictEqual([]);
  expect([...sourceRefs('Data Source: D8')]).toStrictEqual([]);
  expect([...sourceRefs('Mentions D8 with no Source line.')]).toStrictEqual([]);
  // A range is one token, never expanded; words are candidates that a ruling counts only if it is called that.
  expect([...sourceRefs('Source: D1-D5 and D9')]).toStrictEqual(['D1-D5', 'and', 'D9']);
});
