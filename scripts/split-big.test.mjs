/**
 * split-big: the planner moves a root together with everything it needs, never more than a
 * sibling can hold, and names the sibling after its first root without colliding.
 */
import test from 'node:test';
import assert from 'node:assert';

import { closureOf, plan, siblingName } from './split-big.mjs';

const d = (name, size, refs = [], kind = 'fn') => ({ kind, name, size, refs });

test('the closure of a root is the root plus everything it references, transitively', () => {
    const decls = [d('a', 10, ['b']), d('b', 5, ['c']), d('c', 3), d('x', 50)];
    const byName = new Map(decls.map((x) => [x.name, x]));
    assert.deepStrictEqual([...closureOf(byName, ['a'])].sort(), ['a', 'b', 'c']);
});

test('roots join while the closure fits the sibling, shared helpers come along once', () => {
    const decls = [d('shared', 20), d('r1', 100, ['shared']), d('r2', 100, ['shared']), d('r3', 300, ['shared'])];
    const p = plan(decls, { need: 150, maxSibling: 250 });
    assert.ok(p);
    assert.deepStrictEqual([...p.names].sort(), ['r1', 'r2', 'shared']);
    assert.strictEqual(p.lines, 220);
});

test('no plan when nothing big enough fits, statements are never moved, skipped names stay', () => {
    assert.strictEqual(plan([d('a', 500)], { need: 100, maxSibling: 380 }), null);
    assert.strictEqual(plan([d('s', 200, [], 'stmt')], { need: 100, maxSibling: 380 }), null);
    assert.strictEqual(plan([d('a', 200), d('b', 10)], { need: 100, maxSibling: 380, skip: new Set(['a']) }), null);
});

test('the sibling is named after the first root and never takes an existing name', () => {
    assert.match(siblingName('/x/stores/fooStore.js', '_getEgressLog'), /stores\/fooStoreGetEgressLog\.js$/);
    const taken = new Set(['/x/stores/fooStoreGetEgressLog.js']);
    assert.match(siblingName('/x/stores/fooStore.js', 'getEgressLog', (t) => taken.has(t)), /fooStoreGetEgressLog2\.js$/);
});

test('constant-case roots are camel-cased in the sibling name and the plan is balanced, not maximal', () => {
    assert.match(siblingName('/x/a/foo.js', 'MAX_TITLE'), /fooMaxTitle\.js$/);
    const decls = [d('r1', 60), d('r2', 60), d('r3', 60), d('r4', 60)];
    const p = plan(decls, { need: 70, maxSibling: 380 });
    assert.ok(p && p.lines < 240, `moved ${p?.lines}`);
});
