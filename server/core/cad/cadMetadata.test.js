/**
 * CAD metadata reader — the summaries an LLM gets instead of raw geometry.
 *
 * The properties under test: extents + unit conversion and the entity
 * histogram for ASCII DXF, the STEP HEADER fields, the honesty line for the
 * binary formats, the 2 KB cap, and — above all — that extractCad NEVER
 * throws, whatever bytes arrive.
 *
 * Run: cd server && node --test core/cadMetadata.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { extractCad, detectFormat, SUMMARY_CAP } = require('./cadMetadata');

// ── Fixtures (built inline — pairs of group-code line / value line) ─
const DXF_ASCII = [
    '  0', 'SECTION', '  2', 'HEADER',
    '  9', '$ACADVER', '  1', 'AC1027',
    '  9', '$INSUNITS', ' 70', '     1',
    '  9', '$EXTMIN', ' 10', '0.0', ' 20', '0.0', ' 30', '0.0',
    '  9', '$EXTMAX', ' 10', '10.0', ' 20', '5.0', ' 30', '0.0',
    '  0', 'ENDSEC',
    '  0', 'SECTION', '  2', 'ENTITIES',
    '  0', 'LINE', ' 10', '0.0', ' 20', '0.0', ' 11', '1.0', ' 21', '1.0',
    '  0', 'CIRCLE', ' 10', '2.0', ' 20', '2.0', ' 40', '0.25',
    '  0', 'CIRCLE', ' 10', '4.0', ' 20', '2.0', ' 40', '0.25',
    '  0', 'LWPOLYLINE', ' 90', '4',
    '  0', 'ENDSEC',
    '  0', 'EOF',
].join('\r\n') + '\r\n';

const STEP_FIXTURE = [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('Sheet metal bracket'),'2;1');",
    "FILE_NAME('BRK-4711-A','2026-08-13T10:00:00',('Tom'),('Acme BV'),'writer 1.0','system','');",
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    "#1=CARTESIAN_POINT('',(0.,0.,0.));",
    'ENDSEC;',
    'END-ISO-10303-21;',
].join('\n');

const DXF_BINARY = Buffer.concat([
    Buffer.from('AutoCAD Binary DXF\r\n', 'latin1'),
    Buffer.from([0x1a, 0x00]),
    Buffer.alloc(64, 7),
]);

const DWG = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(32, 0)]);

const IGES = Buffer.from(
    'Acme flange export'.padEnd(72) + 'S0000001\n' +
    '1H,,1H;,7Hflange,,32,38,6,308,15;'.padEnd(72) + 'G0000001\n',
);

// ── Format detection ────────────────────────────────────────────────
test('detectFormat recognises all five formats and refuses garbage', () => {
    assert.strictEqual(detectFormat(Buffer.from(DXF_ASCII)), 'dxf');
    assert.strictEqual(detectFormat(Buffer.from(STEP_FIXTURE)), 'step');
    assert.strictEqual(detectFormat(DXF_BINARY), 'dxf-binary');
    assert.strictEqual(detectFormat(DWG), 'dwg');
    assert.strictEqual(detectFormat(IGES), 'iges');
    assert.strictEqual(detectFormat(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), null, 'an MZ header is not CAD');
    assert.strictEqual(detectFormat(Buffer.from('hello world\n')), null);
});

// ── ASCII DXF ───────────────────────────────────────────────────────
test('ASCII DXF: extents converted via $INSUNITS, entity histogram counted', () => {
    const res = extractCad(Buffer.from(DXF_ASCII), 'plate.dxf');
    assert.strictEqual(res.kind, 'text');
    assert.strictEqual(res.source, 'cad');
    assert.strictEqual(res.meta.format, 'dxf');
    assert.strictEqual(res.meta.acadVer, 'AC1027');
    assert.strictEqual(res.meta.release, '2013');

    // $INSUNITS = 1 → inches → mm. 10 in × 5 in = 254 mm × 127 mm.
    assert.strictEqual(res.meta.extents.widthMm, 254);
    assert.strictEqual(res.meta.extents.heightMm, 127);
    assert.ok(res.text.includes('254'), 'width in the summary');
    assert.ok(res.text.includes('127'), 'height in the summary');

    assert.deepStrictEqual(res.meta.entities, { LINE: 1, CIRCLE: 2, LWPOLYLINE: 1 });
    assert.ok(res.text.includes('CIRCLE ×2'), 'circle count (≈ hole callouts) in the summary');
});

test('ASCII DXF: the summary OPENS with what was and was not read', () => {
    const res = extractCad(Buffer.from(DXF_ASCII), 'plate.dxf');
    const firstLine = res.text.split('\n')[0];
    assert.match(firstLine, /not interpreted/i, 'the honesty line comes first');
    assert.ok(!res.text.includes('$ACADVER'), 'the raw body is never dumped');
});

test('ASCII DXF: an unknown $INSUNITS code is reported raw, never converted on a guess', () => {
    const dxf = [
        '  0', 'SECTION', '  2', 'HEADER',
        '  9', '$INSUNITS', ' 70', '3', // "miles" — not in our map
        '  9', '$EXTMIN', ' 10', '0.0', ' 20', '0.0',
        '  9', '$EXTMAX', ' 10', '10.0', ' 20', '5.0',
        '  0', 'ENDSEC', '  0', 'EOF',
    ].join('\r\n');
    const res = extractCad(Buffer.from(dxf), 'odd.dxf');
    assert.strictEqual(res.meta.extents.converted, false);
    assert.strictEqual(res.meta.extents.width, 10);
    assert.match(res.text, /NOT converted/i);
    assert.match(res.text, /unknown unit code 3/i);
});

// ── STEP ────────────────────────────────────────────────────────────
test('STEP: FILE_NAME, FILE_DESCRIPTION and FILE_SCHEMA come out of the HEADER', () => {
    const res = extractCad(Buffer.from(STEP_FIXTURE), 'bracket.step');
    assert.strictEqual(res.meta.format, 'step');
    assert.strictEqual(res.meta.fileName, 'BRK-4711-A', 'first FILE_NAME string arg — the part number');
    assert.strictEqual(res.meta.description, 'Sheet metal bracket');
    assert.strictEqual(res.meta.ap, 'AP214');
    assert.ok(res.text.includes('BRK-4711-A'));
    assert.ok(res.text.includes('AP214'));
    assert.match(res.text.split('\n')[0], /only the file header was read/i);
});

test('STEP: escaped quotes in a header string are unescaped', () => {
    const step = "ISO-10303-21;\nHEADER;\nFILE_NAME('Tom''s part','',(''),(''),'','','');\nENDSEC;\n";
    const res = extractCad(Buffer.from(step), 'p.step');
    assert.strictEqual(res.meta.fileName, "Tom's part");
});

// ── Binary formats: honesty, never guessing ─────────────────────────
test('binary DXF: identified, size reported, header plainly NOT read', () => {
    const res = extractCad(DXF_BINARY, 'plate.dxf');
    assert.strictEqual(res.meta.format, 'dxf-binary');
    assert.strictEqual(res.meta.bytes, DXF_BINARY.length);
    assert.match(res.text, /was not read/i);
    assert.ok(!/\d+(\.\d+)?\s*mm/.test(res.text), 'no invented dimensions');
});

test('DWG: version mapped from the AC10xx magic, geometry not read', () => {
    const res = extractCad(DWG, 'drawing.dwg');
    assert.strictEqual(res.meta.format, 'dwg');
    assert.strictEqual(res.meta.dwgVersion, 'AC1032');
    assert.strictEqual(res.meta.release, '2018+');
    assert.match(res.text, /was not read/i);
});

test('IGES: identify + size only', () => {
    const res = extractCad(IGES, 'flange.iges');
    assert.strictEqual(res.meta.format, 'iges');
    assert.strictEqual(res.meta.bytes, IGES.length);
    assert.match(res.text, /were not read/i);
});

// ── The 2 KB cap ────────────────────────────────────────────────────
test('a summary never exceeds 2 KB, whatever the header contains', () => {
    const huge = "ISO-10303-21;\nHEADER;\nFILE_NAME('" + 'A'.repeat(10000) + "','',(''),(''),'','','');\nENDSEC;\n";
    const res = extractCad(Buffer.from(huge), 'huge.step');
    assert.ok(res.text.length <= SUMMARY_CAP, `${res.text.length} ≤ ${SUMMARY_CAP}`);
});

// ── NEVER throws ────────────────────────────────────────────────────
test('extractCad never throws — truncated, hostile or plain wrong input degrades', () => {
    const nasty = [
        [null, 'part.step'],
        [undefined, 'part.step'],
        [Buffer.alloc(0), 'part.step'],
        [Buffer.from([0x00, 0xff, 0x1a, 0x03]), 'part.step'],
        [Buffer.from('ISO-10303-21;\nHEADER;\nFILE_NA'), 'truncated.step'],
        [Buffer.from('  0\r\nSECTION\r\n  2\r\nHEA'), 'truncated.dxf'],
        [Buffer.from('AutoCAD Binary DXF\r\n', 'latin1'), 'half-sentinel.dxf'],
        [Buffer.from('AC10'), 'short.dwg'],
        ['a string, not a buffer', 'weird.igs'],
    ];
    for (const [buf, name] of nasty) {
        const res = extractCad(buf, name);
        assert.strictEqual(res.kind, 'text', `${name}: still a text result`);
        assert.strictEqual(res.source, 'cad');
        assert.ok(res.text.length > 0 && res.text.length <= SUMMARY_CAP);
        assert.ok(res.meta.format, `${name}: meta.format present`);
    }
});

test('garbage flagged as CAD by its name says so honestly', () => {
    const res = extractCad(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), 'part.step');
    assert.strictEqual(res.meta.format, 'unknown');
    assert.match(res.text, /no known CAD signature/i);
    assert.match(res.text, /nothing was read/i);
});
