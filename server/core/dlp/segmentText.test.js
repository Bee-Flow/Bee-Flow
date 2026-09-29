'use strict';
/**
 * Segmentation is the foundation the scan ledger sits on: if a segment can be
 * windowed by detectPii it can come back degraded, and degraded results are
 * never cached — which would silently reinstate the per-turn full re-scan this
 * whole mechanism exists to remove.
 */
const test = require('node:test');
const assert = require('node:assert');
const { segmentText } = require('./segmentText');

const MAX = 8000;
const OVERLAP = 256;
const opts = { maxChars: MAX, overlapChars: OVERLAP };

function build(n, seed = 'a') {
    // Prose-ish with paragraph breaks, deterministic.
    let s = '';
    let i = 0;
    while (s.length < n) {
        s += `${seed}${i} the quick brown fox jumps over the lazy dog number ${i}.`;
        if (i % 7 === 0) s += '\n\n';
        i++;
    }
    return s.slice(0, n);
}

test('segments reassemble to the original text exactly', () => {
    const text = build(60_000);
    const segs = segmentText(text, opts);
    assert.ok(segs.length > 1, 'precondition: text must actually split');
    assert.strictEqual(segs.map(s => text.slice(s.start, s.end)).join(''), text);
    assert.strictEqual(segs[0].start, 0);
    assert.strictEqual(segs[segs.length - 1].end, text.length);
});

test('scanned string never exceeds MAX_REQUEST_CHARS, so detectPii cannot window it', () => {
    for (const len of [9_000, 60_000, 130_000]) {
        for (const segs of [segmentText(build(len), opts)]) {
            for (const s of segs) {
                assert.ok(s.scanText.length <= MAX,
                    `segment of ${s.scanText.length} chars would be windowed (len=${len})`);
                assert.strictEqual(s.scanText, build(len).slice(s.scanStart, s.end));
            }
        }
    }
});

test('text with no line breaks at all still respects the cap', () => {
    const text = 'x'.repeat(60_000);
    const segs = segmentText(text, opts);
    assert.ok(segs.length > 1);
    for (const s of segs) assert.ok(s.scanText.length <= MAX, `${s.scanText.length} > ${MAX}`);
    assert.strictEqual(segs.map(s => text.slice(s.start, s.end)).join(''), text);
});

test('each segment carries the left overlap except the first', () => {
    const segs = segmentText(build(60_000), opts);
    assert.strictEqual(segs[0].scanStart, 0);
    for (const s of segs.slice(1)) {
        assert.strictEqual(s.scanStart, s.start - OVERLAP,
            'a boundary-straddling entity must be visible whole to the next segment');
    }
});

test('an edit near the top re-synchronises instead of invalidating every later key', () => {
    // The property the whole cache depends on: content-defined boundaries.
    const text = build(60_000);
    const edited = 'INSERTED PARAGRAPH.\n\n' + text;

    const before = segmentText(text, opts).map(s => text.slice(s.start, s.end));
    const after = segmentText(edited, opts).map(s => edited.slice(s.start, s.end));

    const beforeSet = new Set(before);
    const survivors = after.filter(seg => beforeSet.has(seg)).length;
    assert.ok(survivors >= before.length - 3,
        `expected nearly all segments to survive a top-of-document insert, kept ${survivors}/${before.length}`);
});

test('short text is one segment with no overlap', () => {
    const segs = segmentText('short and harmless', opts);
    assert.strictEqual(segs.length, 1);
    assert.deepStrictEqual(
        { start: segs[0].start, scanStart: segs[0].scanStart },
        { start: 0, scanStart: 0 },
    );
});

test('empty and non-string input yield no segments', () => {
    assert.deepStrictEqual(segmentText(''), []);
    assert.deepStrictEqual(segmentText(null), []);
    assert.deepStrictEqual(segmentText(undefined), []);
});
