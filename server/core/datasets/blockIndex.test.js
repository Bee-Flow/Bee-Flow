/**
 * core/datasets — block index serialization + range search.
 * Run: cd server && node --test core/datasets/blockIndex.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { serialize, deserialize, findRange } = require('./blockIndex');

// Two contigs, blocks in file order. chr1: firstPos 100/500/900 at offsets
// 0/1000/2000; chr2: firstPos 50/800 at offsets 3000/4000; content ends at 5000.
function fixtureIndex() {
    const buf = serialize([
        {
            name: 'chr1', minPos: 100, maxPos: 1150, count: 30,
            entries: [
                { firstPos: 100, blockOffset: 0, uncompSize: 60000 },
                { firstPos: 500, blockOffset: 1000, uncompSize: 60000 },
                { firstPos: 900, blockOffset: 2000, uncompSize: 42000 },
            ],
        },
        {
            name: 'chr2', minPos: 50, maxPos: 950, count: 12,
            entries: [
                { firstPos: 50, blockOffset: 3000, uncompSize: 61000 },
                { firstPos: 800, blockOffset: 4000, uncompSize: 20000 },
            ],
        },
    ], 5000);
    return deserialize(buf);
}

test('round trip preserves directory, stats and every entry', () => {
    const idx = fixtureIndex();
    assert.strictEqual(idx.contentEnd, 5000);
    assert.strictEqual(idx.entryCount, 5);
    assert.deepStrictEqual(idx.contigs.map((c) => c.name), ['chr1', 'chr2']);
    assert.strictEqual(idx.byName.get('chr1').count, 30);
    assert.strictEqual(idx.firstPosAt(3), 50);
    assert.strictEqual(idx.blockOffsetAt(3), 3000);
    assert.strictEqual(idx.uncompSizeAt(4), 20000);
});

test('findRange: a span inside one block reads exactly that block', () => {
    const idx = fixtureIndex();
    const r = findRange(idx, 'chr1', 510, 520);
    assert.deepStrictEqual(
        { startOffset: r.startOffset, endOffset: r.endOffset, blockCount: r.blockCount, truncated: r.truncated },
        { startOffset: 1000, endOffset: 2000, blockCount: 1, truncated: false },
    );
});

test('findRange: a span starting mid-block includes the covering block', () => {
    const idx = fixtureIndex();
    // 450 sits inside the block whose firstPos is 100 — that block must be read.
    const r = findRange(idx, 'chr1', 450, 950);
    assert.strictEqual(r.startOffset, 0);
    assert.strictEqual(r.endOffset, 3000, 'last chr1 block ends where chr2 begins');
    assert.strictEqual(r.blockCount, 3);
});

test('findRange: the LAST block of the file ends at contentEnd', () => {
    const idx = fixtureIndex();
    const r = findRange(idx, 'chr2', 800, 999999);
    assert.strictEqual(r.startOffset, 4000);
    assert.strictEqual(r.endOffset, 5000, 'contentEnd bounds the final block, EOF marker excluded');
});

test('findRange: contig absent → null; span before/after all rows → empty', () => {
    const idx = fixtureIndex();
    assert.strictEqual(findRange(idx, 'chrX', 1, 100), null);
    assert.deepStrictEqual(findRange(idx, 'chr2', 1, 40), { empty: true });
    // A span past the last firstPos still reads the final covering block —
    // rows after firstPos 800 might reach it; the row filter decides.
    const tail = findRange(idx, 'chr1', 1200, 1300);
    assert.strictEqual(tail.startOffset, 2000);
    assert.strictEqual(tail.blockCount, 1);
});

test('findRange: maxBlocks clamps and says so', () => {
    const idx = fixtureIndex();
    const r = findRange(idx, 'chr1', 100, 950, { maxBlocks: 2 });
    assert.strictEqual(r.blockCount, 2);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.endOffset, 2000, 'clamped window ends before the third block');
});

test('serialize refuses unsorted entries; deserialize refuses corruption', () => {
    assert.throws(() => serialize([{
        name: 'chr1', minPos: 0, maxPos: 0, count: 0,
        entries: [
            { firstPos: 500, blockOffset: 0, uncompSize: 1 },
            { firstPos: 100, blockOffset: 1000, uncompSize: 1 },
        ],
    }], 100), /not pos-sorted/);
    assert.throws(() => deserialize(Buffer.from('garbage')), /not a BFDI1/);
    const good = serialize([{ name: 'c', minPos: 1, maxPos: 1, count: 1, entries: [{ firstPos: 1, blockOffset: 0, uncompSize: 1 }] }], 10);
    assert.throws(() => deserialize(good.subarray(0, good.length - 8)), /declares 1 entries, file has 0/);
});
