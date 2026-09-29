/**
 * Unit tests for walkRelativePath — path resolution RELATIVE to an arbitrary
 * value (the parse_json step + /map-json-fields verification both use it;
 * agent-hub/src/utils/bindingHelpers.js mirrors these cases byte-for-byte).
 *
 * Run: node --test automation/bind.walkRelativePath.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { walkRelativePath } = require('./bind');

test('empty path, "$", and nullish path return the whole source', () => {
    const src = { a: 1 };
    assert.strictEqual(walkRelativePath('', src), src);
    assert.strictEqual(walkRelativePath('$', src), src);
    assert.strictEqual(walkRelativePath(null, src), src);
    assert.strictEqual(walkRelativePath(undefined, src), src);
});

test('dotted object paths resolve', () => {
    const src = { order: { customer: { email: 'a@b.c' } } };
    assert.strictEqual(walkRelativePath('order.customer.email', src), 'a@b.c');
});

test('numeric index and quoted-key segments resolve', () => {
    const src = { items: [{ sku: 'X1' }, { sku: 'X2' }], 'key with spaces': { v: 7 } };
    assert.strictEqual(walkRelativePath('items[0].sku', src), 'X1');
    assert.strictEqual(walkRelativePath('items[1].sku', src), 'X2');
    assert.strictEqual(walkRelativePath('["key with spaces"].v', src), 7);
    assert.strictEqual(walkRelativePath("['key with spaces'].v", src), 7);
});

test('leading bracket segment supports root-array sources', () => {
    const src = [{ id: 'a' }, { id: 'b' }];
    assert.strictEqual(walkRelativePath('[0].id', src), 'a');
    assert.deepStrictEqual(walkRelativePath('[*].id', src), ['a', 'b']);
});

test('[*] maps + flattens one level (server resolveTokens semantics)', () => {
    const src = { orders: [{ lines: [{ sku: 'A' }, { sku: 'B' }] }, { lines: [{ sku: 'C' }] }] };
    assert.deepStrictEqual(walkRelativePath('orders[*].lines', src), [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }]);
    assert.deepStrictEqual(walkRelativePath('orders[*].lines[*].sku', src), ['A', 'B', 'C']);
});

test('missing paths resolve to undefined (tolerant intermediates)', () => {
    assert.strictEqual(walkRelativePath('a.b.c', { a: {} }), undefined);
    assert.strictEqual(walkRelativePath('items[5].x', { items: [] }), undefined);
    assert.strictEqual(walkRelativePath('x', null), undefined);
});

test('prototype-chain members are blocked (own properties only)', () => {
    const src = { a: 1 };
    assert.strictEqual(walkRelativePath('constructor', src), undefined);
    assert.strictEqual(walkRelativePath('__proto__', src), undefined);
    assert.strictEqual(walkRelativePath('a.toFixed', src), undefined);
    // Array indices / .length ARE own properties — legitimate access works.
    assert.strictEqual(walkRelativePath('list.length', { list: [1, 2] }), 2);
});

test('non-string weirdness is rejected safely', () => {
    // A bare-digit key fails REF_RE's identifier rule — bracket form works.
    assert.strictEqual(walkRelativePath(0, { 0: 'zero' }), undefined);
    assert.strictEqual(walkRelativePath('[0]', ['zero']), 'zero');
    // A malformed path (unclosed bracket) → undefined, no throw.
    assert.strictEqual(walkRelativePath('items[0', { items: ['x'] }), undefined);
});
