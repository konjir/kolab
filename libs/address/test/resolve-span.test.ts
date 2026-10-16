import { describe, expect, test } from '@jest/globals';
import { FUZZY_THRESHOLD, MATCH_MAX_BITS, type QuoteSelector, resolveSpan, SHORT_QUOTE, similarity } from '@konjir/address';

// ADR8: an exact match in a new position is clean ('exact'), a near match counts as a change
// ('fuzzy'), and no match leaves an orphan. Offsets are into the whitespace-normalized text.

const at = (text: string, sel: QuoteSelector) => {
  const r = resolveSpan(text, sel);
  return r.status === 'orphan' ? r : { ...r, located: text.replace(/\s+/g, ' ').trim().slice(r.start, r.end) };
};

/** Deterministic filler prose that shares the quotes' vocabulary, so near misses are everywhere. */
function filler(bytes: number, seed = 7): string {
  const words = 'order cart payment refund checkout user guest session price tax receipt invoice save later share'.split(' ');
  let x = seed;
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
  test('a quote that moved within its element, with its context, is exact at its new offset', () => {
    const sel = { exact: 'save a cart for later', prefix: 'Users can ', suffix: ' and share it' };
    const r = at('Guests may browse. Signed-in users can save a cart for later, too.', sel);
    expect(r).toMatchObject({ status: 'exact', content: 'save a cart for later', located: 'save a cart for later' });
    expect(r.status === 'exact' && r.start).toBe(39);
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
    // A 2 KB quote in the element's own vocabulary that is gone: its slices hit all over the element.
    ['orphan, 2 KB quote', text, { exact: filler(2_000, 99) }, 'orphan'],
    ['orphan, 2 KB quote with context', text, { exact: filler(2_000, 99), prefix: 'order cart payment', suffix: 'refund checkout' }, 'orphan'],
  ];
  test.each(cases)('100 KB element, %s', (_name, haystack, sel, status) => {
    const t0 = performance.now();
    const r = resolveSpan(haystack, sel);
    const ms = performance.now() - t0;
    expect(r.status).toBe(status);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe('D42: the context decides whether a verbatim match is exact', () => {
  test('an edited original plus a verbatim copy elsewhere: the edited original, as a change', () => {
    const text = 'Alpha said save the cart now. Beta said save a cart later.';
    expect(at(text, { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' }))
      .toMatchObject({ status: 'fuzzy', located: 'save a cart', start: 40 });
  });

  test('a verbatim copy whose context does not agree, with nothing near where it pointed, is a change at the copy', () => {
    const text = 'Alpha said save the cart now. Beta left.';
    expect(at(text, { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' }))
      .toMatchObject({ status: 'fuzzy', similarity: 1, located: 'save the cart', start: 11 });
    // Context recorded, none of it left anywhere: still a change, never clean.
    expect(resolveSpan('Users may save the cart.', { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' }).status)
      .toBe('fuzzy');
  });

  test('an edited original plus a near copy elsewhere: the one the context points at', () => {
    // Alpha's "save the carts" is closer to the quote; Beta's "save a cart" is where the context points.
    const text = 'Alpha said save the carts now. Beta said save a cart later.';
    expect(at(text, { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' }))
      .toMatchObject({ status: 'fuzzy', located: 'save a cart', start: 41 });
  });

  test('a moved quote with either side of its context still there is exact', () => {
    const sel = { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' };
    expect(at('Intro first. Then Beta said save the cart much later.', sel)).toMatchObject({ status: 'exact', start: 28 });
    expect(at('Intro first. Then Gamma: save the cart later.', sel)).toMatchObject({ status: 'exact', start: 25 });
  });

  test('a verbatim copy whose context agrees beats one with more matching characters that does not', () => {
    // The first copy keeps " said" and "lat" (one word of two, and part of one); the second, all of the prefix.
    const text = 'X said save the cart lat. Beta said save the cart now.';
    expect(at(text, { exact: 'save the cart', prefix: 'Beta said', suffix: 'later.' })).toMatchObject({ status: 'exact', start: 36 });
  });

  test('without any recorded context, a verbatim match is exact wherever it is', () => {
    expect(at('Alpha said save the cart now. Beta said save a cart later.', { exact: 'save the cart' }))
      .toMatchObject({ status: 'exact', start: 11 });
  });
});

describe('a verbatim match must be whole words', () => {
  test('a quote glued to a longer word is not exact: the changed word is a near match', () => {
    expect(at('Retain logs for 300 days.', { exact: 'Retain logs for 30', suffix: 'days.' }))
      .toMatchObject({ status: 'fuzzy', located: 'Retain logs for 300' });
    expect(at('Users can save the carts for later.', { exact: 'save the cart', suffix: 'for later' }))
      .toMatchObject({ status: 'fuzzy', located: 'save the carts' });
  });

  test('a quote found only inside a longer word is an orphan', () => {
    expect(resolveSpan('We concatenate the files.', { exact: 'cat' }).status).toBe('orphan');
  });

  test('a whole-word occurrence wins over one inside a word', () => {
    expect(at('Retain logs for 300 days. Retain logs for 30 days.', { exact: 'Retain logs for 30' }))
      .toMatchObject({ status: 'exact', start: 26 });
  });

  test('punctuation is a boundary', () => {
    expect(at('Note: (save a cart for later)!', { exact: 'save a cart for later' })).toMatchObject({ status: 'exact', start: 7 });
  });

  test('scripts written without spaces have a boundary between any two characters', () => {
    expect(at('支付完成后三十秒内结账', { exact: '三十秒' })).toMatchObject({ status: 'exact', start: 5, end: 8 });
    expect(at('ข้อมูลถูกบันทึกทันที', { exact: 'บันทึก' })).toMatchObject({ status: 'exact' });
  });
});

describe('a fuzzy span is whole words', () => {
  test('an edited last word is taken whole, not cut where the old word ended', () => {
    expect(at('Users can save the cart for afterwards and share it.', { exact: 'Users can save the cart for later', suffix: 'and share' }))
      .toMatchObject({ status: 'fuzzy', located: 'Users can save the cart for afterwards' });
  });

  test('replacing words at the end are kept, up to the end of the sentence', () => {
    expect(at('The system must respond within 2 seconds. Logs are kept.', { exact: 'The system must respond within 200 ms.' }))
      .toMatchObject({ status: 'fuzzy', located: 'The system must respond within 2 seconds.' });
  });

  test('an edited first word is taken whole', () => {
    expect(at('Note that checkouts complete within 30 seconds of payment.', { exact: 'Checkout completes within 30 seconds of payment' }))
      .toMatchObject({ status: 'fuzzy', located: 'checkouts complete within 30 seconds of payment' });
  });
});

describe(`a quote shorter than ${SHORT_QUOTE} characters needs its context for a near match`, () => {
  test('with its context gone, a one-letter-off word elsewhere is an orphan', () => {
    expect(resolveSpan('Pay by card. Some fine text follows here.', { exact: 'cart', prefix: 'save the', suffix: 'for later' }).status)
      .toBe('orphan');
    expect(resolveSpan('We also must hurry.', { exact: 'just', prefix: 'it is', suffix: 'fine' }).status).toBe('orphan');
  });

  test('without any recorded context, it is exact or an orphan', () => {
    expect(resolveSpan('Pay by card.', { exact: 'cart' }).status).toBe('orphan');
    expect(resolveSpan('Pay by cart.', { exact: 'cart' }).status).toBe('exact');
  });

  test('with its context still there, an edit is a near match', () => {
    expect(at('Users can save the card for later.', { exact: 'cart', prefix: 'save the', suffix: 'for later' }))
      .toMatchObject({ status: 'fuzzy', located: 'card' });
    // Two near matches: the one whose context agrees.
    expect(at('Pay by card. Then save the card.', { exact: 'cart', prefix: 'Then save the' }))
      .toMatchObject({ status: 'fuzzy', start: 27 });
  });
});

describe('Unicode', () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test('a fuzzy span never splits an emoji or a combining sequence', () => {
    const r = at('Intro 😂😂 the party 😁🎉 starts at nine tonight.', { exact: '😀 the party 😁🎉 starts at nine', prefix: 'Intro' });
    expect(r).toMatchObject({ status: 'fuzzy', located: '😂 the party 😁🎉 starts at nine' });
    const marks = at('Read: ñ̃ the café notes, then leave.', { exact: 'the cafe notes, then go', prefix: 'Read:' });
    expect(marks.status).toBe('fuzzy');
    expect(marks.status !== 'orphan' && marks.content).not.toMatch(/^\p{M}/u);
  });

  test('fuzzy content is always well-formed UTF-16', () => {
    const pool = ['😂', '😁', '🎉', '👍🏽', 'a', 'b', ' ', '文', 'é', 'e\u0301', 'cart', 'save'];
    let x = 3;
    const pick = () => pool[(x = (x * 1103515245 + 12345) & 0x7fffffff) % pool.length];
    for (let i = 0; i < 500; i++) {
      const text = Array.from({ length: 24 }, pick).join('');
      const exact = Array.from({ length: 10 }, pick).join('');
      const r = resolveSpan(text, { exact, prefix: pick() + pick() });
      if (r.status !== 'orphan') expect(r.content).not.toMatch(LONE);
    }
  });

  test('a quote matches text that encodes the same characters differently (NFC against NFD)', () => {
    const nfd = 'Order a cafe\u0301 au lait now.';
    const r = at(nfd, { exact: 'caf\u00e9 au lait' });
    expect(r).toMatchObject({ status: 'exact', content: 'caf\u00e9 au lait', start: 8, end: 21 });
    expect(r.status !== 'orphan' && r.located).toBe('cafe\u0301 au lait');
  });

  test('fuzzy offsets and content are in the text as given, not its NFC form', () => {
    const r = at('D\u00e9j\u00e0: cafe\u0301s au lait are served now.', { exact: 'caf\u00e9 au lait is served', prefix: 'D\u00e9j\u00e0:' });
    expect(r).toMatchObject({ status: 'fuzzy', content: 'cafe\u0301s au lait are served' });
    expect(r.status !== 'orphan' && r.located).toBe('cafe\u0301s au lait are served');
  });
});

test('similarity is one minus the edit distance over the longer length', () => {
  expect(similarity('abc', 'abc')).toBe(1);
  expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
  expect(similarity('', '')).toBe(1);
});
