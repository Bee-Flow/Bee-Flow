/**
 * Range header parsing.
 *
 * Run: cd server && node --test core/httpRange.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseRangeHeader } = require('./httpRange');

const SIZE = 1000;

test('no header means "serve the whole thing", which is not the same as invalid', () => {
    assert.strictEqual(parseRangeHeader(undefined, SIZE), null);
    assert.strictEqual(parseRangeHeader('', SIZE), null);
    assert.strictEqual(parseRangeHeader(null, SIZE), null);
});

test('a closed range is inclusive on both ends', () => {
    assert.deepStrictEqual(parseRangeHeader('bytes=2-5', SIZE), { start: 2, end: 5 });
    // 4 bytes, not 3 — an off-by-one here truncates every seek.
    const r = parseRangeHeader('bytes=2-5', SIZE);
    assert.strictEqual(r.end - r.start + 1, 4);
});

test('an open end runs to the last byte', () => {
    assert.deepStrictEqual(parseRangeHeader('bytes=900-', SIZE), { start: 900, end: 999 });
    assert.deepStrictEqual(parseRangeHeader('bytes=0-', SIZE), { start: 0, end: 999 });
});

test('a suffix range is the LAST n bytes', () => {
    // "bytes=-500" is not "the first 500". Getting this backwards hands the
    // player the beginning of the file when it asked for the end.
    assert.deepStrictEqual(parseRangeHeader('bytes=-500', SIZE), { start: 500, end: 999 });
    // A suffix larger than the resource clamps to the whole thing.
    assert.deepStrictEqual(parseRangeHeader('bytes=-5000', SIZE), { start: 0, end: 999 });
});

test('an end past the resource is clamped, not rejected', () => {
    // Browsers routinely probe with a large end while the length is unknown.
    assert.deepStrictEqual(parseRangeHeader('bytes=0-99999', SIZE), { start: 0, end: 999 });
});

test('multi-range is refused rather than silently serving the first part', () => {
    // Answering with only the first part looks like success and returns the
    // wrong bytes; a multipart/byteranges body is the only correct answer.
    assert.deepStrictEqual(parseRangeHeader('bytes=0-1,5-6', SIZE), { invalid: true });
});

test('malformed and unsatisfiable ranges are invalid', () => {
    for (const bad of ['bytes=abc', 'items=0-5', 'bytes=', 'bytes=-', 'bytes=5-2', 'bytes=1000-1001', 'bytes=-0', 'garbage']) {
        assert.deepStrictEqual(parseRangeHeader(bad, SIZE), { invalid: true }, `expected invalid: ${bad}`);
    }
});

test('a zero or unknown resource size is unsatisfiable', () => {
    assert.deepStrictEqual(parseRangeHeader('bytes=0-1', 0), { invalid: true });
    assert.deepStrictEqual(parseRangeHeader('bytes=0-1', undefined), { invalid: true });
});

test('whitespace and case are tolerated', () => {
    assert.deepStrictEqual(parseRangeHeader('  bytes=2-5  ', SIZE), { start: 2, end: 5 });
    assert.deepStrictEqual(parseRangeHeader('BYTES=2-5', SIZE), { start: 2, end: 5 });
});
