/**
 * The parts of walk.mjs the corpus (WALK_V2) does not show as data: the Many
 * marker, the item count, the JSON memo and its limits, and the roots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    walk, walkMany, walkSource, sourceBase, isMany, manyItems, plain, parseJsonText, MAX_JSON_TEXT, REFUSED_KEYS,
} from './walk.mjs';

const rows = [{ x: 1, tags: ['a', 'b'] }, { x: 2, tags: [] }, null, { tags: ['c'] }];

test('a key on a list maps over it; an index indexes', () => {
    assert.deepStrictEqual(walk(rows, ['x']), [1, 2, undefined, undefined]);
    assert.deepStrictEqual(walk(rows, [0, 'x']), 1);
    assert.deepStrictEqual(walk(rows, ['tags']), [['a', 'b'], [], undefined, ['c']], 'lists in lists stay lists');
    assert.ok(isMany(walkMany(rows, ['x'])));
    assert.ok(!isMany(walkMany(rows, [0, 'x'])));
    assert.ok(!isMany(walkMany(rows, [])), 'a list the path ends on is a value, not a walk over it');
});

test('manyItems: what count and all both read', () => {
    assert.deepStrictEqual(manyItems(walkMany(rows, ['x'])), { items: [1, 2], holes: 2 });
    assert.deepStrictEqual(manyItems(walkMany(rows, ['tags'])), { items: ['a', 'b', 'c'], holes: 1 });
    // REGRESSION (confirmed bug "bind.js and the expression engine treat null
    // rows differently under [*]"): the list as a whole keeps its null row,
    // and its count says so; count(items[*]) said 3 while the ref sent 4.
    assert.deepStrictEqual(manyItems(walkMany(rows, [])), { items: rows, holes: 0 });
    assert.equal(manyItems(walkMany(rows, [])).items.length, 4);
    assert.deepStrictEqual(manyItems('one'), { items: ['one'], holes: 0 });
    assert.deepStrictEqual(manyItems(undefined), { items: [], holes: 0 });
    assert.deepStrictEqual(manyItems(null), { items: [], holes: 0 }, 'an empty field holds no items');
});

test('only own properties, and never the refused keys', () => {
    const own = JSON.parse('{"__proto__":{"x":1},"constructor":"c","length":3,"prototype":"p","ok":1}');
    for (const key of REFUSED_KEYS) assert.equal(walk(own, [key]), undefined, key);
    assert.equal(walk(own, ['ok']), 1);
    assert.equal(walk({}, ['toString']), undefined);
    assert.equal(walk('abc', ['length']), undefined);
    assert.equal(walk([1, 2], [-1]), undefined);
    assert.equal(walk([1, 2], [0.5]), undefined);
    assert.equal(walk({ a: 1 }, [{ wild: true }]), undefined, 'a v2 path has no [*]');
    assert.equal(walk({ a: 1 }, 'a'), undefined, 'a path is an array');
});

test('a JSON text is read only when a deeper segment asks, once per memo', () => {
    const text = '{"a":{"b":[1,2]}}';
    assert.equal(walk({ t: text }, ['t']), text, 'the text itself, when nothing deeper is asked');
    assert.deepStrictEqual(walk({ t: text }, ['t', 'a', 'b']), [1, 2]);
    const memo = new Map();
    walk({ t: text }, ['t', 'a'], { memo });
    assert.equal(memo.size, 1);
    const cached = memo.get(text);
    assert.strictEqual(walk({ t: text }, ['t', 'a'], { memo }), cached.a, 'the second read is the parsed object');
    assert.equal(parseJsonText('"just a string"'), undefined);
    assert.equal(parseJsonText('{broken'), undefined);
    assert.equal(parseJsonText(`[${' '.repeat(MAX_JSON_TEXT)}]`), undefined, 'over the cap is not parsed');
    for (let i = 0; i < 70; i++) parseJsonText(`[${i}]`, memo);
    assert.ok(memo.size <= 64, `the memo is bounded (${memo.size})`);
});

test('the roots of a Source in a run', () => {
    const state = {
        steps: { s1: { output: { a: 1 } } },
        trigger: { output: { t: 2 }, id: 'trg', headers: { h: 1 } },
        vars: { v: 3 },
        loop: { row: { r: 4 } },
        item: { i: 5 },
        secrets: { k: 'secret' },
    };
    assert.equal(walkSource({ root: 'steps', id: 's1', path: ['a'] }, state), 1);
    assert.equal(walkSource({ root: 'trigger', path: ['t'] }, state), 2);
    assert.equal(walkSource({ root: 'run', path: ['id'] }, state), 'trg');
    assert.equal(walkSource({ root: 'run', path: ['output', 't'] }, state), undefined, 'the payload is the trigger root');
    assert.equal(walkSource({ root: 'run', path: ['headers', 'h'] }, state), undefined);
    assert.equal(walkSource({ root: 'vars', path: ['v'] }, state), 3);
    assert.equal(walkSource({ root: 'loop', id: 'row', path: ['r'] }, state), 4);
    assert.equal(walkSource({ root: 'item', path: ['i'] }, state), 5);
    assert.equal(walkSource({ root: 'secrets', path: ['k'] }, state), undefined, 'no pick reads a secret');
    assert.equal(sourceBase(null, state), undefined);
    assert.equal(plain(walkSource({ root: 'steps', id: 'nope', path: [] }, state)), undefined);
});
