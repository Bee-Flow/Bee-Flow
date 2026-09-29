'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOperations } = require('./contentLexer');

const parse = (s) => parseOperations(Buffer.from(s, 'latin1'));

test('each operation covers its operands and operator, so cutting it removes it cleanly', () => {
    const src = 'q 1 0 0 1 10 20 cm BT /F1 12 Tf (Hello) Tj ET Q';
    const { ops, malformed } = parse(src);
    assert.equal(malformed, 0);
    assert.deepEqual(ops.map((o) => o.op), ['q', 'cm', 'BT', 'Tf', 'Tj', 'ET', 'Q']);
    const tj = ops.find((o) => o.op === 'Tj');
    assert.equal(src.slice(tj.start, tj.end), '(Hello) Tj');
    assert.equal(tj.operands[0].bytes.toString('latin1'), 'Hello');
    const cm = ops.find((o) => o.op === 'cm');
    assert.deepEqual(cm.operands, [1, 0, 0, 1, 10, 20]);
});

test('literal strings keep nested parentheses and decode escapes', () => {
    const { ops } = parse('(a (b) c\\) \\101\\n) Tj');
    assert.equal(ops[0].operands[0].bytes.toString('latin1'), 'a (b) c) A\n');
});

test('hex strings, names with #xx escapes, arrays and dictionaries parse as operands', () => {
    const { ops } = parse('/Na#20me <00410042> [(x) -120 (y)] TJ /P <</MCID 3>> BDC EMC');
    assert.equal(ops[0].op, 'TJ');
    assert.deepEqual(ops[0].operands[0], { name: 'Na me' });
    assert.deepEqual([...ops[0].operands[1].bytes], [0x00, 0x41, 0x00, 0x42]);
    assert.equal(ops[0].operands[2].length, 3);
    assert.equal(ops[1].op, 'BDC');
    assert.deepEqual(ops[1].operands[1], { dict: { MCID: 3 } });
});

test('comments are skipped and an inline image is one operation up to EI', () => {
    const src = '% a comment\nBI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\xff EI Q';
    const { ops } = parse(src);
    assert.deepEqual(ops.map((o) => o.op), ['BI', 'Q']);
    assert.equal(src.slice(ops[0].start, ops[0].end).endsWith(' EI'), true);
    assert.deepEqual(ops[0].operands[0].dict.W, 2);
});

test('dangling operands and stray delimiters are counted as malformed', () => {
    assert.equal(parse('1 0 0 RG ) 5').malformed, 2);
});
