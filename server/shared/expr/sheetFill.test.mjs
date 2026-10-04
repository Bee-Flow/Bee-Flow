// Fill-down and fill-right (sheetFill.mjs), shared by the grid and the assistant.
// Run: node --test server/shared/expr/sheetFill.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftFormula, fillBlock } from './sheetFill.mjs';

test('relative references shift, $ anchors stay, quotes and values are untouched', () => {
    assert.equal(shiftFormula('=B2*$C$1', 0, 3), '=B5*$C$1');
    assert.equal(shiftFormula('=$B2+B$2', 2, 2), '=$B4+D$2');
    assert.equal(shiftFormula('=IF(A1>0,"see B2","")', 0, 1), '=IF(A2>0,"see B2","")');
    assert.equal(shiftFormula('42', 1, 1), '42');
    assert.equal(shiftFormula('=A1', -1, 0), '=#REF!');
});

test('fill down copies the first row over the block; fill right the first column', () => {
    const cells = { D2: '=B2*C2', E2: 'x', B5: '=SUM(B2:B4)' };
    const raw = (c, r) => cells[`${String.fromCharCode(65 + c)}${r + 1}`] || '';
    assert.deepEqual(fillBlock({ c0: 3, r0: 1, c1: 4, r1: 3 }, 'down', raw),
        { D3: '=B3*C3', E3: 'x', D4: '=B4*C4', E4: 'x' });
    assert.deepEqual(fillBlock({ c0: 1, r0: 4, c1: 3, r1: 4 }, 'right', raw),
        { C5: '=SUM(C2:C4)', D5: '=SUM(D2:D4)' });
    // An empty source clears what it fills over, as in a spreadsheet.
    assert.deepEqual(fillBlock({ c0: 0, r0: 0, c1: 0, r1: 1 }, 'down', raw), { A2: '' });
});
