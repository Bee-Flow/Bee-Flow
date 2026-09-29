/**
 * core/datasets — rsID shard index.
 * Run: cd server && node --test core/datasets/rsidIndex.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { SHARD_COUNT, shardOf, shardName, serializeShard, lookupShard } = require('./rsidIndex');

test('shardOf / shardName agree with the storage artifact vocabulary', () => {
    assert.strictEqual(shardOf(548049170), 548049170 % 64);
    assert.strictEqual(shardName(7), '07');
    assert.strictEqual(shardName(63), '63');
    assert.throws(() => shardName(64), /0\.\.63/);
    assert.strictEqual(SHARD_COUNT, 64);
});

test('serialize sorts; lookup finds singles, duplicates and misses', () => {
    const shard = serializeShard([
        { rsNum: 5000, contigIdx: 2, pos: 999 },
        { rsNum: 64, contigIdx: 0, pos: 100 },
        { rsNum: 5000, contigIdx: 2, pos: 1001 },   // multi-allelic split line
        { rsNum: 128, contigIdx: 1, pos: 200 },
    ]);
    assert.deepStrictEqual(lookupShard(shard, 64), [{ contigIdx: 0, pos: 100 }]);
    assert.deepStrictEqual(lookupShard(shard, 5000), [
        { contigIdx: 2, pos: 999 },
        { contigIdx: 2, pos: 1001 },
    ]);
    assert.deepStrictEqual(lookupShard(shard, 4936), []);
    assert.deepStrictEqual(lookupShard(Buffer.alloc(0), 64), [], 'empty shard = no matches');
});

test('lookup scales: 100k records, hit at both extremes', () => {
    const records = [];
    for (let i = 0; i < 100_000; i++) records.push({ rsNum: i * 64 + 3, contigIdx: i % 25, pos: i });
    const shard = serializeShard(records);
    assert.deepStrictEqual(lookupShard(shard, 3), [{ contigIdx: 0, pos: 0 }]);
    assert.deepStrictEqual(lookupShard(shard, 99_999 * 64 + 3), [{ contigIdx: 99_999 % 25, pos: 99_999 }]);
    assert.deepStrictEqual(lookupShard(shard, 4), []);
});

test('malformed shard buffers are refused', () => {
    assert.throws(() => lookupShard(Buffer.alloc(15), 1), /malformed/);
});
