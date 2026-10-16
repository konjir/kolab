import { describe, expect, test } from '@jest/globals';
import { FUZZY_THRESHOLD, MATCH_MAX_BITS, type QuoteSelector, resolveSpan, similarity } from '@konjir/address';

// ADR8: an exact match in a new position is clean ('exact'), a near match counts as a change
// ('fuzzy'), and no match leaves an orphan. Offsets are into the whitespace-normalized text.

const at = (text: string, sel: QuoteSelector) => {
  const r = resolveSpan(text, sel);
  return r.status === 'orphan' ? r : { ...r, located: text.replace(/\s+/g, ' ').trim().slice(r.start, r.end) };
};

/** Deterministic filler prose that shares the quotes' vocabulary, so near misses are everywhere. */
function filler(bytes: number): string {
  const words = 'order cart payment refund checkout user guest session price tax receipt invoice save later share'.split(' ');
  let x = 7;
  const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  let out = '';
  while (out.length < bytes) {
    const n = 6 + (next() % 8);
    const s: string[] = [];
    for (let i = 0; i < n; i++) s.push(words[next() % words.length]);
    out += `${s.join(' ')}. `;
  }
  return out;
}

const LONG = 'Checkout completes within thirty seconds of the payment provider confirming the charge, '
  + 'and the receipt is emailed to the address on the order at once.';

describe('moved exact quotes are clean', () => {
  test('a quote that moved within its element is exact, at its new offset', () => {
    const sel = { exact: 'save a cart for later', prefix: 'Users can ', suffix: ' and share it' };
    const r = at('Guests may browse. Signed-in users can now save a cart for later, too.', sel);
    expect(r).toMatchObject({ status: 'exact', content: 'save a cart for later', located: 'save a cart for later' });
    expect(r.status === 'exact' && r.start).toBe(43);
  });

  test('whitespace differences are not edits', () => {
    expect(resolveSpan('Users can\n  save a\tcart   for later.', { exact: 'save a cart\nfor later' }).status).toBe('exact');
  });
});

describe('small edits are fuzzy', () => {
  test('a one-word rewording is a near match, with the new wording as content', () => {
    const r = at('Users can save the cart for later and share it.', { exact: 'save a cart for later' });
    expect(r).toMatchObject({ status: 'fuzzy', content: 'save the cart for later', located: 'save the cart for later' });
    expect(r.status === 'fuzzy' && r.similarity).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    expect(r.status === 'fuzzy' && r.similarity).toBeLessThan(1);
  });

  test('a near match far from where its context says is still found', () => {
    // The prefix now points at the start; the quote, reworded, sits at the end.
    const text = `Users can browse. ${filler(2_000)} Anyone may save the cart for later.`;
    expect(at(text, { exact: 'save a cart for later', prefix: 'Users can ' })).toMatchObject({
      status: 'fuzzy', located: 'save the cart for later',
    });
  });
});

describe('deleted quotes are orphans', () => {
  test('a quote whose words are gone is an orphan', () => {
    expect(resolveSpan('Users can export receipts.', { exact: 'save a cart for later' }).status).toBe('orphan');
  });

  test('a rewrite past the threshold is an orphan, not a weak match', () => {
    expect(resolveSpan('Users may keep carts.', { exact: 'save a cart for later' }).status).toBe('orphan');
    expect(resolveSpan(filler(5_000), { exact: 'save a cart for later', prefix: 'Users can ' }).status).toBe('orphan');
  });

  test('an empty quote or an empty element is an orphan', () => {
    expect(resolveSpan('Users can save a cart.', { exact: '  ' }).status).toBe('orphan');
    expect(resolveSpan('', { exact: 'save a cart' }).status).toBe('orphan');
  });
});

describe('repeated phrases: the context decides', () => {
  const text = 'Admins can save a cart for later. Users can save a cart for later.';

  test('without context, the first occurrence', () => {
    expect(at(text, { exact: 'save a cart for later' })).toMatchObject({ status: 'exact', start: 11 });
  });

  test('the prefix picks the occurrence it still precedes', () => {
    expect(at(text, { exact: 'save a cart for later', prefix: 'Users can ' })).toMatchObject({ status: 'exact', start: 44 });
    expect(at(text, { exact: 'save a cart for later', prefix: 'Admins can ' })).toMatchObject({ status: 'exact', start: 11 });
  });

  test('the suffix picks the occurrence it still follows', () => {
    const t = 'Save a cart for later today. Then save a cart for later again.';
    expect(at(t, { exact: 'a cart for later', suffix: ' again' })).toMatchObject({ status: 'exact', start: 39 });
  });

  test('among near matches, the prefix picks too', () => {
    const t = 'Admins can save the cart for later. Users can save the cart for later.';
    expect(at(t, { exact: 'save a cart for later', prefix: 'Users can ' })).toMatchObject({ status: 'fuzzy', start: 46 });
    expect(at(t, { exact: 'save a cart for later', prefix: 'Admins can ' })).toMatchObject({ status: 'fuzzy', start: 11 });
  });
});

describe(`quotes longer than bitap's ${MATCH_MAX_BITS}-character pattern`, () => {
  test('a long quote that moved is exact', () => {
    expect(LONG.length).toBeGreaterThan(4 * MATCH_MAX_BITS);
    expect(at(`Intro. ${filler(3_000)} ${LONG} Outro.`, { exact: LONG })).toMatchObject({ status: 'exact', located: LONG });
  });

  test('a long quote edited in the middle is fuzzy, spanning the whole edited quote', () => {
    const edited = LONG.replace('thirty', '30');
    expect(at(`Intro. ${filler(3_000)} ${edited} Outro.`, { exact: LONG })).toMatchObject({ status: 'fuzzy', located: edited });
  });

  test('a long quote edited at its head and tail is still found whole', () => {
    const edited = LONG.replace('Checkout completes', 'Checkouts complete').replace('at once.', 'right away.');
    expect(at(`Intro. ${edited} Outro.`, { exact: LONG })).toMatchObject({ status: 'fuzzy', located: edited });
  });

  test('a quote longer than the sampled slices is matched and verified in full', () => {
    const quote = Array.from({ length: 12 }, (_, i) => `${LONG.slice(0, -1)} (clause ${i}).`).join(' ');
    expect(quote.length).toBeGreaterThan(16 * MATCH_MAX_BITS);
    const edited = quote.replace('(clause 5)', '(clause five)');
    expect(at(`Intro. ${quote} Outro.`, { exact: quote })).toMatchObject({ status: 'exact' });
    expect(at(`Intro. ${edited} Outro.`, { exact: quote })).toMatchObject({ status: 'fuzzy', located: edited });
    // Half of it rewritten: below the threshold, whatever its slices find.
    const halved = `${quote.slice(0, quote.length / 2)} ${filler(quote.length / 2)}`;
    expect(resolveSpan(`Intro. ${halved} Outro.`, { exact: quote }).status).toBe('orphan');
  });
});

describe('a long element does not slow matching sharply', () => {
  // The hand-written window scan took about 3.3 s (a 31-character quote) and 48 s (a 120-character quote)
  // on a 100 KB element; see the W2.3 pull request. The bound here is loose, for slow CI machines.
  const BOUND_MS = 1_000;
  const text = filler(100 * 1024);
  const mid = Math.floor(text.length / 2);
  const inserted = (s: string) => `${text.slice(0, mid)} ${s} ${text.slice(mid)}`;
  const cases: [string, string, QuoteSelector, string][] = [
    ['exact', inserted('Users can save a cart for later'), { exact: 'Users can save a cart for later' }, 'exact'],
    ['fuzzy', inserted('Users can save the cart for later'), { exact: 'Users can save a cart for later' }, 'fuzzy'],
    ['orphan', text, { exact: 'Admins may export every invoice' }, 'orphan'],
    ['fuzzy, long quote', inserted(LONG.replace('thirty', '30')), { exact: LONG }, 'fuzzy'],
    ['orphan, long quote', text, { exact: LONG }, 'orphan'],
  ];
  test.each(cases)('100 KB element, %s', (_name, haystack, sel, status) => {
    const t0 = performance.now();
    const r = resolveSpan(haystack, sel);
    const ms = performance.now() - t0;
    expect(r.status).toBe(status);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

test('similarity is one minus the edit distance over the longer length', () => {
  expect(similarity('abc', 'abc')).toBe(1);
  expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
  expect(similarity('', '')).toBe(1);
});
