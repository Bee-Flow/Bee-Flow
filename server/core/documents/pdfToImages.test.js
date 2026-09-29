/**
 * The scale maths for the PDF → PNG fallback. Real rendering needs pdfjs +
 * @napi-rs/canvas and is exercised in the running stack; here we pin the pure
 * per-page scale computation so the vision-token budget maths cannot silently
 * regress. (Claude downsamples to ~1568 px long edge; image tokens are
 * (w×h)/750 — rendering past the target is pure waste, rendering the old
 * fixed 1.5 made dimension text unreadable.)
 *
 * Run: cd server && node --test core/pdfToImages.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { computeRenderScale } = require('./pdfToImages');

test('an explicit scale wins, whatever else is passed', () => {
    assert.strictEqual(computeRenderScale({ width: 612, height: 792, scale: 1.5, targetLongEdge: 1568 }), 1.5);
    assert.strictEqual(computeRenderScale({ width: 100, height: 100, scale: 3 }), 3);
});

test('targetLongEdge computes a per-page scale from the LONGER edge', () => {
    // Portrait letter: 612×792 pt — the height is the long edge.
    const p = computeRenderScale({ width: 612, height: 792, targetLongEdge: 1568 });
    assert.ok(Math.abs(p - 1568 / 792) < 1e-9, `${p} ≈ ${1568 / 792}`);
    // Landscape A3: 1190×842 pt — the WIDTH is the long edge.
    const l = computeRenderScale({ width: 1190, height: 842, targetLongEdge: 1568 });
    assert.ok(Math.abs(l - 1568 / 1190) < 1e-9, `${l} ≈ ${1568 / 1190}`);
});

test('the computed scale is clamped to [1.0, 4.0]', () => {
    assert.strictEqual(computeRenderScale({ width: 2000, height: 3000, targetLongEdge: 1568 }), 1.0, 'never renders below 1:1');
    assert.strictEqual(computeRenderScale({ width: 100, height: 80, targetLongEdge: 1568 }), 4.0, 'never blows a tiny page up past 4x');
});

test('neither scale nor targetLongEdge → the legacy fixed 1.5', () => {
    assert.strictEqual(computeRenderScale({ width: 612, height: 792 }), 1.5);
    assert.strictEqual(computeRenderScale({}), 1.5);
    assert.strictEqual(computeRenderScale(), 1.5);
});

test('degenerate viewports fall back to the default rather than dividing by zero', () => {
    assert.strictEqual(computeRenderScale({ width: 0, height: 0, targetLongEdge: 1568 }), 1.5);
    assert.strictEqual(computeRenderScale({ width: NaN, height: undefined, targetLongEdge: 1568 }), 1.5);
});
