/**
 * The shared CAD type table — one allowlist, three consumers (uploadGuard,
 * mailboxAttachments, attachmentExtractor). These tests pin the mapping so a
 * drift in any consumer shows up here first.
 *
 * Run: cd server && node --test utils/cadTypes.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    CAD_EXT_TO_MIME,
    CAD_MIME_ALIASES,
    CAD_MIME_FAMILIES,
    CAD_CANONICAL_MIMES,
    GENERIC_MIMES,
    cadMimeForName,
    canonicalCadMime,
    isCadMime,
} = require('./cadTypes');

test('cadMimeForName maps every CAD extension to its canonical mime', () => {
    assert.strictEqual(cadMimeForName('part.step'), 'model/step');
    assert.strictEqual(cadMimeForName('PART.STP'), 'model/step');
    assert.strictEqual(cadMimeForName('exchange.p21'), 'model/step');
    assert.strictEqual(cadMimeForName('plate.dxf'), 'image/vnd.dxf');
    assert.strictEqual(cadMimeForName('drawing.DWG'), 'image/vnd.dwg');
    assert.strictEqual(cadMimeForName('flange.iges'), 'model/iges');
    assert.strictEqual(cadMimeForName('flange.igs'), 'model/iges');
});

test('cadMimeForName answers null for anything else — only the LAST extension counts', () => {
    assert.strictEqual(cadMimeForName('a.txt'), null);
    assert.strictEqual(cadMimeForName('part.step.exe'), null, 'a double extension does not smuggle CAD in');
    assert.strictEqual(cadMimeForName('noextension'), null);
    assert.strictEqual(cadMimeForName(''), null);
    assert.strictEqual(cadMimeForName(null), null);
    assert.strictEqual(cadMimeForName(undefined), null);
});

test('canonicalCadMime folds every alias and passes canonicals through', () => {
    for (const [alias, canonical] of Object.entries(CAD_MIME_ALIASES)) {
        assert.strictEqual(canonicalCadMime(alias), canonical, `${alias} → ${canonical}`);
    }
    for (const canonical of CAD_CANONICAL_MIMES) {
        assert.strictEqual(canonicalCadMime(canonical), canonical, `${canonical} → itself`);
    }
    assert.strictEqual(canonicalCadMime('Application/DXF'), 'image/vnd.dxf', 'case-insensitive');
    assert.strictEqual(canonicalCadMime('application/pdf'), null);
    assert.strictEqual(canonicalCadMime(''), null);
    assert.strictEqual(canonicalCadMime(null), null);
});

test('isCadMime accepts canonicals + aliases, refuses the rest', () => {
    assert.ok(isCadMime('model/step'));
    assert.ok(isCadMime('drawing/x-dwg'));
    assert.ok(!isCadMime('application/pdf'));
    assert.ok(!isCadMime('application/octet-stream'), 'a generic mime is NOT a CAD mime');
    assert.ok(!isCadMime(''));
});

test('GENERIC_MIMES is exactly the says-nothing set', () => {
    for (const g of ['', 'application/octet-stream', 'application/binary', 'binary/octet-stream']) {
        assert.ok(GENERIC_MIMES.has(g), `${JSON.stringify(g)} is generic`);
    }
    assert.ok(!GENERIC_MIMES.has('application/pdf'));
    assert.ok(!GENERIC_MIMES.has('model/step'));
});

test('the table is internally coherent — nothing can drift', () => {
    // Every extension and every alias lands on a canonical mime that has a
    // byte-family entry; the canonical set IS the family table's key set.
    for (const mime of Object.values(CAD_EXT_TO_MIME)) {
        assert.ok(CAD_MIME_FAMILIES[mime], `extension target ${mime} has families`);
    }
    for (const mime of Object.values(CAD_MIME_ALIASES)) {
        assert.ok(CAD_MIME_FAMILIES[mime], `alias target ${mime} has families`);
    }
    assert.deepStrictEqual(
        [...CAD_CANONICAL_MIMES].sort(),
        Object.keys(CAD_MIME_FAMILIES).sort(),
    );
});

// ── ASCII DXF recognition ───────────────────────────────────────────

/** A DXF the way a nesting/CAM exporter writes one: a 999 banner, no HEADER. */
const EXPORTER_DXF = [
    '999', 'DXF written by the nesting post-processor',
    '  0', 'SECTION', '  2', 'ENTITIES',
    '  0', 'LWPOLYLINE', '  8', '0',
    '  0', 'ENDSEC', '  0', 'EOF', '',
].join('\r\n');

test('isAsciiDxfHead accepts the shapes real DXF writers produce', () => {
    const { isAsciiDxfHead } = require('./cadTypes');

    // THE BUG THIS ENCODES: the rule used to be anchored at byte 0, so a file
    // opening with a 999 comment only passed if $ACADVER turned up within the
    // first 2 KB. Exporters that write a banner AND no HEADER section — the
    // waterjet/laser tools a sheet-metal shop is mailed all day — matched
    // neither branch. Their .DXF sniffed as plain text and every intake
    // refused it as "not what it claims to be", while a .step went through
    // because ISO-10303-21; is always its very first token.
    assert.strictEqual(isAsciiDxfHead(EXPORTER_DXF), true, '999 banner + entities only');
    assert.strictEqual(isAsciiDxfHead('  0\r\nSECTION\r\n  2\r\nENTITIES\r\n'), true, 'entities only');
    assert.strictEqual(isAsciiDxfHead('0\nSECTION\n2\nHEADER\n'), true, 'no indent, LF newlines');
    assert.strictEqual(isAsciiDxfHead('  9\r\n$ACADVER\r\n  1\r\nAC1009\r\n'), true, '$ACADVER anywhere in the head');
    // Several banners in a row, which is also legal.
    assert.strictEqual(isAsciiDxfHead('999\r\none\r\n999\r\ntwo\r\n  0\r\nSECTION\r\n'), true);

    // …and still refuses anything that merely CONTAINS the word.
    assert.strictEqual(isAsciiDxfHead('Dear supplier,\r\nSECTION 4 of the order\r\n'), false);
    assert.strictEqual(isAsciiDxfHead('999\r\nonly a banner, nothing after it\r\n'), false);
    assert.strictEqual(isAsciiDxfHead('  1\r\nSECTION\r\n'), false, 'the opener is group code 0, not any code');
    assert.strictEqual(isAsciiDxfHead(''), false);
    assert.strictEqual(isAsciiDxfHead(null), false);

    // The comment skip is bounded, so a file of nothing but banners cannot
    // walk the scanner forward for free.
    const banners = Array.from({ length: 40 }, (_, i) => `999\r\nbanner ${i}\r\n`).join('');
    assert.strictEqual(isAsciiDxfHead(`${banners}  0\r\nSECTION\r\n`), false, 'past the comment limit');
});

test('the storage sniff and the drawing reader agree on the same bytes', () => {
    // The invariant the shared helper exists for: uploadGuard decides whether
    // the bytes may be STORED, cadMetadata decides whether they are READ. A
    // file accepted by one and not the other is a drawing filed as a blob.
    const { sniffFamily } = require('../middleware/uploadGuard');
    const { detectFormat } = require('../core/cad/cadMetadata');
    const buf = Buffer.from(EXPORTER_DXF, 'utf8');

    assert.strictEqual(sniffFamily(buf), 'dxf');
    assert.strictEqual(detectFormat(buf), 'dxf');
});
