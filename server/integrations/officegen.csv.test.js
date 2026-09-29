/**
 * Unit tests for officegen's CSV builder — the hardened plain-text sibling of
 * `buildSpreadsheet`. The dangerous part of CSV is not the format but the
 * consumer: these files get double-clicked into Excel, so every string cell
 * must be neutralised against formula injection BEFORE RFC 4180 quoting.
 *
 * Run: node --test integrations/officegen.csv.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const office = require('./officegen');

/** Decode a buildCsv buffer to text, asserting on + stripping the BOM. */
function decode(buffer, { expectBom = true } = {}) {
    const text = buffer.toString('utf8');
    if (expectBom) {
        assert.deepStrictEqual([...buffer.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM at buffer start');
        return text.slice(1);
    }
    assert.notStrictEqual(text.charCodeAt(0), 0xfeff, 'no BOM expected');
    return text;
}

test('buildCsv — header + rows, `;` delimiter, BOM, CRLF line ends incl. trailing', () => {
    const { buffer, contentType, format } = office.buildCsv({
        matrix: [['Invoice', 'Vendor'], ['202600117', 'Van Dijk Kantoor B.V.'], ['202600342', 'De Vries Brandstof B.V.']],
    });
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
    assert.strictEqual(contentType, 'text/csv');
    assert.strictEqual(format, 'csv');
    assert.strictEqual(
        decode(buffer),
        'Invoice;Vendor\r\n202600117;Van Dijk Kantoor B.V.\r\n202600342;De Vries Brandstof B.V.\r\n',
    );
});

test('buildCsv — RFC 4180 quoting: delimiter, embedded quote, embedded newline', () => {
    const { buffer } = office.buildCsv({ matrix: [['a;b', 'say "hi"', 'line1\nline2', 'plain']] });
    assert.strictEqual(decode(buffer), '"a;b";"say ""hi""";"line1\nline2";plain\r\n');
});

test('buildCsv — formula-injection: leading = + - @ TAB CR strings get a quote prefix', () => {
    const { buffer } = office.buildCsv({
        matrix: [["=cmd|' /C calc'!A0", '+1+1', '-1+1', '@SUM(A1)', '\tleading tab', '\rleading cr']],
    });
    // The CR-leading cell shows the ordering: prefix FIRST, then RFC 4180
    // quoting wraps it (it contains \r) with the prefix safely inside.
    assert.strictEqual(
        decode(buffer),
        "'=cmd|' /C calc'!A0;'+1+1;'-1+1;'@SUM(A1);'\tleading tab;\"'\rleading cr\"\r\n",
    );
});

test('buildCsv — numbers stay bare: only STRING cells are prefixed', () => {
    const { buffer } = office.buildCsv({ matrix: [[12.5, -5, '-5', true, false]] });
    assert.strictEqual(decode(buffer), "12.5;-5;'-5;true;false\r\n");
});

test('buildCsv — null/undefined → empty cell, objects → JSON (quoted: contains `"`)', () => {
    const { buffer } = office.buildCsv({ matrix: [[null, undefined, { a: 1 }]] });
    assert.strictEqual(decode(buffer), ';;"{""a"":1}"\r\n');
});

test('buildCsv — bom:false omits the BOM', () => {
    const { buffer } = office.buildCsv({ matrix: [['x']], bom: false });
    assert.strictEqual(decode(buffer, { expectBom: false }), 'x\r\n');
});

test('buildCsv — `,` delimiter honoured (and switches what gets quoted)', () => {
    const { buffer } = office.buildCsv({ matrix: [['a,b', 'a;b']], delimiter: ',' });
    assert.strictEqual(decode(buffer), '"a,b",a;b\r\n');
});

test('buildCsv — unknown delimiter falls back to `;`', () => {
    const { buffer } = office.buildCsv({ matrix: [['a', 'b']], delimiter: '|' });
    assert.strictEqual(decode(buffer), 'a;b\r\n');
});

test('buildCsv — custom eol joins rows (still with a trailing one)', () => {
    const { buffer } = office.buildCsv({ matrix: [['a'], ['b']], eol: '\n' });
    assert.strictEqual(decode(buffer), 'a\nb\n');
});

test('buildCsv — empty/non-array matrix → BOM-only buffer, no throw', () => {
    const empty = office.buildCsv({ matrix: [] });
    assert.strictEqual(decode(empty.buffer), '', 'empty matrix → BOM only');
    const bogus = office.buildCsv({ matrix: 'not-a-matrix' });
    assert.strictEqual(decode(bogus.buffer), '', 'non-array matrix treated as empty');
    const bare = office.buildCsv({ matrix: [], bom: false });
    assert.strictEqual(bare.buffer.length, 0, 'no BOM → truly empty buffer');
});

test('CONTENT_TYPES.csv registered', () => {
    assert.strictEqual(office.CONTENT_TYPES.csv, 'text/csv');
});

test('buildCsv — accepts a rowsToMatrix matrix like buildSpreadsheet does', () => {
    const matrix = office.rowsToMatrix([
        { Invoice: '202600117', Amount: 47.87 },
        { Invoice: '=HYPERLINK("http://evil")', Amount: -5 },
    ]);
    const { buffer } = office.buildCsv({ matrix });
    assert.strictEqual(
        decode(buffer),
        'Invoice;Amount\r\n202600117;47.87\r\n"\'=HYPERLINK(""http://evil"")";-5\r\n',
    );
});
