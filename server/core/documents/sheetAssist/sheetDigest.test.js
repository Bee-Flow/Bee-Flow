'use strict';

/**
 * What the spreadsheet assistant sees (sheetDigest.js): a compact table, the
 * whole sheet when small, head + tail + column profiles when large, errors
 * and the selection always.
 *
 * Run: cd server && node --test core/documents/sheetAssist/sheetDigest.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { sheetDigest, rowsBlock } = require('./sheetDigest');
const { evaluateSheet } = require('../../../shared/expr/sheet.mjs');
const { parseRange } = require('./sheetRefs');

const small = { A1: 'Item', B1: 'Qty', C1: 'Price', D1: 'Total', A2: 'Pens', B2: '3', C2: '1.5', D2: '=B2*C2', D4: '=D2/0' };

test('a small sheet goes in whole, as rows, formulas with their result', () => {
    const d = sheetDigest(small, evaluateSheet(small), { name: 'Shop' });
    assert.match(d, /used range A1:D4 \(4 rows × 4 columns, 9 filled cells\)/);
    assert.match(d, /#\| A \| B \| C \| D/);
    assert.match(d, /2\| Pens \| 3 \| 1\.5 \| =B2\*C2⇒4\.5/);
    assert.match(d, /\n3\|\n/, 'a blank row is one short line');
    assert.match(d, /Cells showing an error: D4 #DIV\/0!/);
    assert.doesNotMatch(d, /"A1"/, 'not JSON');
});

test('a large sheet goes as head, tail and column profiles', () => {
    const big = { A1: 'n', B1: 'double' };
    for (let r = 2; r <= 400; r++) { big[`A${r}`] = String(r); big[`B${r}`] = `=A${r}*2`; }
    const d = sheetDigest(big, evaluateSheet(big), { name: 'Big' });
    assert.match(d, /First 15 rows:/);
    assert.match(d, /Last rows \(396–400\):/);
    assert.match(d, /B: 400 filled, 399 formulas, 399 numbers, min 4, max 800, sum 160398/);
    assert.doesNotMatch(d, /\n200\|/, 'the middle is left to read_range');
    assert.ok(d.length < 4000, `compact: ${d.length} chars`);
});

test('the selection is always shown; pipes and newlines in a cell are escaped', () => {
    const cells = { A1: 'a|b', A2: 'line1\nline2', C9: 'far' };
    const d = sheetDigest(cells, evaluateSheet(cells), { name: 'S', selection: parseRange('C9') });
    assert.match(d, /The user has selected C9:\n#\| C\n9\| far/);
    assert.match(d, /a\\\|b/);
    assert.match(d, /line1\\nline2/);
    assert.strictEqual(sheetDigest({}, {}, { name: 'E' }), 'Sheet "E" is empty. Columns A–Z, rows 1–2000.');
    assert.strictEqual(rowsBlock(cells, evaluateSheet(cells), { r0: 1, r1: 1, c1: 0 }), '#| A\n1| a\\|b');
});
