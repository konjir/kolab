// The address grammar (DAT11, ADR3, D8): kj:[<kolab>/]<node>[@<version>][#<element>][~q(<selector>)],
// parsed and printed in this one module. Without a kolab it is the short form, read inside a kolab.
import { expect, test } from '@jest/globals';
import { formatAddress, isKolabName, isNodeName, parseAddress, parseNodeRef } from '@konjir/address';

const thrown = (fn: () => unknown) => {
  try { fn(); } catch (e) { return String(e); }
  throw new Error('expected it to throw');
};

test('the kolab segment is parsed, and printed back as it was written', () => {
  for (const s of [
    'kj:checkout',
    'kj:shop/checkout',
    'kj:shop/checkout@7',
    'kj:shop/checkout@7#R1',
    'kj:shop-2/spec.v2#R1~q({"exact":"a/b @ c#d ~e","prefix":"within "})',
    'kj:kolab/kolab',
    'kj:checkout#sec/R1',
  ]) expect(formatAddress(parseAddress(s))).toBe(s);
  expect(parseAddress('kj:shop/checkout@7#R1')).toStrictEqual({ kolab: 'shop', node: 'checkout', version: 7, element: 'R1', selector: undefined });
  expect(parseAddress('kj:checkout@7')).toStrictEqual({ node: 'checkout', version: 7, element: undefined, selector: undefined });
  // A '/' after the node belongs to the element or selector, never to the kolab.
  expect(parseAddress('kj:checkout#sec/R1')).toMatchObject({ node: 'checkout', element: 'sec/R1' });
  expect(parseAddress('kj:checkout#R1~q({"exact":"x/y"})')).toMatchObject({ node: 'checkout', element: 'R1', selector: { exact: 'x/y' } });
  expect(parseAddress('kj:kolab/kolab')).toStrictEqual({ kolab: 'kolab', node: 'kolab', version: undefined, element: undefined, selector: undefined });
});

test('the short form is printed inside its kolab, the full form anywhere else', () => {
  const a = { kolab: 'shop', node: 'checkout', version: 3, element: 'R1' };
  expect(formatAddress(a)).toBe('kj:shop/checkout@3#R1');
  expect(formatAddress(a, { from: 'shop' })).toBe('kj:checkout@3#R1');
  expect(formatAddress(a, { from: 'billing' })).toBe('kj:shop/checkout@3#R1');
  expect(formatAddress({ node: 'checkout' }, { from: 'billing' })).toBe('kj:checkout');
});

test('a malformed kolab or node is refused, saying why', () => {
  expect(thrown(() => parseAddress('kj:Shop/checkout'))).toMatch(/Its kolab, "Shop", isn't a kolab name: lowercase letters, digits and '-'/);
  expect(thrown(() => parseAddress('kj:-shop/checkout'))).toMatch(/isn't a kolab name/);
  expect(thrown(() => parseAddress(`kj:${'k'.repeat(101)}/checkout`))).toMatch(/isn't a kolab name/);
  expect(thrown(() => parseAddress('kj:/checkout'))).toMatch(/Its kolab, "", isn't a kolab name/);
  expect(thrown(() => parseAddress('kj:shop/'))).toMatch(/It names no node/);
  expect(thrown(() => parseAddress('kj:shop/a/b'))).toMatch(/not a Konjir address: kj:shop\/a\/b/);
  expect(thrown(() => parseAddress('kj:shop/check out'))).toMatch(/It names no node/);
  expect(thrown(() => parseAddress('kj:@3'))).toMatch(/It names no node/);
  expect(thrown(() => parseAddress('shop/checkout'))).toMatch(/not a Konjir address/);
  expect(thrown(() => parseAddress('kj:shop/checkout~q({"exact":"x"})'))).toMatch(/needs an element/);
});

test('a node named alone: <node>, <kolab>/<node>, or an address with nothing below the node', () => {
  expect(parseNodeRef('checkout')).toStrictEqual({ node: 'checkout' });
  expect(parseNodeRef('shop/checkout')).toStrictEqual({ kolab: 'shop', node: 'checkout' });
  expect(parseNodeRef('kj:shop/checkout')).toStrictEqual({ kolab: 'shop', node: 'checkout' });
  expect(thrown(() => parseNodeRef('shop/checkout@2'))).toMatch(/names a version, element or span; name the node alone/);
  expect(thrown(() => parseNodeRef('Shop/checkout'))).toMatch(/isn't a kolab name/);
});

test('kolab and node names', () => {
  expect([isKolabName('shop'), isKolabName('shop-2'), isKolabName('Shop'), isKolabName('shop_2'), isKolabName('')]).toStrictEqual([true, true, false, false, false]);
  expect([isNodeName('spec.v2'), isNodeName('Checkout_1'), isNodeName('a/b'), isNodeName('a@b'), isNodeName('a#b'), isNodeName('a~b'), isNodeName('a b'), isNodeName('')])
    .toStrictEqual([true, true, false, false, false, false, false, false]);
});
