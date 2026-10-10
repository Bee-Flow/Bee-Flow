import test from 'node:test';
import assert from 'node:assert/strict';
import { assignShards, hashShard, orderLongestFirst, parseShard } from './testShards.mjs';

const names = Array.from({ length: 200 }, (_, i) => `dir${i % 7}/file${i}.test.js`);
const durations = Object.fromEntries(names.slice(0, 150).map((f, i) => [f, (i * 37) % 900 + 50]));

test('every file lands in exactly one shard, known or not', () => {
    for (const n of [1, 2, 3, 5]) {
        const shards = assignShards(names, durations, n);
        assert.equal(shards.length, n);
        assert.deepEqual([...shards.flat()].sort(), [...names].sort());
        assert.equal(new Set(shards.flat()).size, names.length);
    }
});

test('files missing from the durations file go to their hash shard and are not dropped', () => {
    const shards = assignShards(names, durations, 3);
    for (const f of names.slice(150)) assert.ok(shards[hashShard(f, 3)].includes(f));
});

test('assignment does not depend on input order', () => {
    const a = assignShards(names, durations, 3);
    const b = assignShards([...names].reverse(), durations, 3);
    assert.deepEqual(a.map((s) => [...s].sort()), b.map((s) => [...s].sort()));
});

test('the known files are balanced within one longest file', () => {
    const only = names.slice(0, 150);
    const shards = assignShards(only, durations, 3);
    const loads = shards.map((s) => s.reduce((t, f) => t + durations[f], 0));
    assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...Object.values(durations)));
});

test('orderLongestFirst puts the slowest first', () => {
    const o = orderLongestFirst(['a', 'b', 'c'], { a: 1, b: 9, c: 5 });
    assert.deepEqual(o, ['b', 'c', 'a']);
});

test('parseShard accepts i/n and refuses the rest', () => {
    assert.deepEqual(parseShard('2/3'), { index: 2, count: 3 });
    for (const bad of ['0/3', '4/3', 'x', '1/0', undefined]) assert.throws(() => parseShard(bad));
});

import { compareShardLists } from './testShards.mjs';

test('compareShardLists passes a partition and names every missing, doubled and foreign file', () => {
    assert.deepEqual(compareShardLists(['a', 'b', 'c'], [['a'], ['b', 'c']]), []);
    // same COUNT as the full list, but one file lost and one doubled: only a set comparison sees it
    const p = compareShardLists(['a', 'b', 'c'], [['a', 'b'], ['b', 'x']]);
    assert.ok(p.some((m) => /^c runs in NO shard/.test(m)));
    assert.ok(p.some((m) => /^b runs in shard 1 and shard 2/.test(m)));
    assert.ok(p.some((m) => /^x ran in shard 2/.test(m)));
});
