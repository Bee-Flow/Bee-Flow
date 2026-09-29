/**
 * core/datasets — BGZF block round-trip and interop.
 *
 * The one interop fact that matters: a BGZF block IS a complete gzip member,
 * so zlib.gunzipSync must be able to open what writeBlock produces (that is
 * what makes our .bgz files readable by bgzip/samtools), and a concatenation
 * of blocks + EOF_BLOCK must gunzip as one stream.
 *
 * Run: cd server && node --test core/datasets/bgzf.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { writeBlock, readBlock, EOF_BLOCK, MAX_BLOCK_INPUT } = require('./bgzf');

test('round trip: writeBlock → readBlock returns the exact payload', () => {
    const payload = Buffer.from('chr1\t12345\trs42\tA\tG\t99\tPASS\tAF=0.01\n'.repeat(50));
    const block = writeBlock(payload);
    const { data, compressedSize } = readBlock(block);
    assert.ok(data.equals(payload));
    assert.strictEqual(compressedSize, block.length, 'compressedSize spans the whole member');
    assert.ok(block.length <= 65_536);
});

test('blocks are plain gzip members — zlib can open them without us', () => {
    const payload = Buffer.from('interop check\n');
    assert.ok(zlib.gunzipSync(writeBlock(payload)).equals(payload));
});

test('a concatenated block stream (+EOF) gunzips as one multi-member stream', () => {
    const a = Buffer.from('first block\n');
    const b = Buffer.from('second block\n');
    const stream = Buffer.concat([writeBlock(a), writeBlock(b), EOF_BLOCK]);
    assert.strictEqual(zlib.gunzipSync(stream).toString(), 'first block\nsecond block\n');
});

test('consecutive blocks are walkable by compressedSize', () => {
    const parts = ['aaa\n', 'bbbb\n', 'c\n'].map((s) => Buffer.from(s.repeat(100)));
    const stream = Buffer.concat(parts.map(writeBlock));
    let offset = 0;
    const out = [];
    while (offset < stream.length) {
        const { data, compressedSize } = readBlock(stream, offset);
        out.push(data);
        offset += compressedSize;
    }
    assert.ok(Buffer.concat(out).equals(Buffer.concat(parts)));
    assert.strictEqual(offset, stream.length);
});

test('the EOF marker reads as an empty payload', () => {
    const { data, compressedSize } = readBlock(EOF_BLOCK);
    assert.strictEqual(data.length, 0);
    assert.strictEqual(compressedSize, 28);
});

test('input cap: MAX_BLOCK_INPUT fits, one byte more refuses', () => {
    // Incompressible payload — the worst case for the 64 KB member ceiling.
    const incompressible = require('crypto').randomBytes(MAX_BLOCK_INPUT);
    const block = writeBlock(incompressible);
    assert.ok(block.length <= 65_536, `worst-case block is ${block.length}`);
    assert.ok(readBlock(block).data.equals(incompressible));
    assert.throws(() => writeBlock(Buffer.alloc(MAX_BLOCK_INPUT + 1)), /exceeds/);
});

test('corruption is refused, never silently tolerated', () => {
    assert.throws(() => writeBlock(Buffer.alloc(0)), /non-empty/);
    assert.throws(() => readBlock(Buffer.from('plain text, not gzip at all')), /not a gzip member/);
    // A REGULAR gzip member (no FEXTRA) is valid gzip but not BGZF.
    assert.throws(() => readBlock(zlib.gzipSync(Buffer.from('x'))), /FEXTRA|BC subfield/);
    // Truncation mid-body.
    const block = writeBlock(Buffer.from('payload'));
    assert.throws(() => readBlock(block.subarray(0, block.length - 4)), /truncated/);
});
