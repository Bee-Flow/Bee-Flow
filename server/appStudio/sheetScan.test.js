/**
 * App Studio — sheetScan (which spreadsheet in an order package is the BOM).
 *
 * Every fixture here is a shape a customer has actually mailed or plausibly
 * will: a comma CSV, a Dutch/German semicolon CSV, a stripped export whose
 * key column lost the variant, a ready-made line list, and a contact sheet
 * that happens to be the biggest file in the mail.
 *
 * Run: cd server && node --test appStudio/sheetScan.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { scanSheet, looksLikeLineList, MAX_SCAN_BYTES } = require('./sheetScan');
const { normalizeBase } = require('./fileIntake')._internal;

const KEYS = ['3010-005424-01', '3010-007646-01', '3010-009138-01'];
const scan = (text, keys = KEYS) => scanSheet(Buffer.from(text, 'utf8'), { partKeys: keys, normalize: normalizeBase });

test('a bill of materials is recognised by the parts it names, not its size', () => {
    const bom = scan([
        'Item No.,Variant,Drawing,Position,Quantity,Description,Material,Length,Width,Height',
        '3010-005424,01,3060-000435,1,6,FOR GANGWAY,EN AW-6082 T6,98,40,8',
        '3010-007646,01,3060-000435,2,2,FOR FIX PART,EN AW-6082 T6,37,30,10',
    ].join('\n'));
    assert.strictEqual(bom.hits, 2);
    assert.strictEqual(bom.rows, 2, 'the header row is structure, not data');
    assert.strictEqual(bom.columns, 10);
    assert.strictEqual(bom.lineList, false);

    // Ten times the size and about nobody's parts.
    const contacts = scan(`naam,telefoon,adres\n${'Jan,0612345678,Ergens 1\n'.repeat(400)}`);
    assert.strictEqual(contacts.hits, 0);
    assert.ok(contacts.rows > bom.rows, 'and it really is the bigger file');
});

test('the article number and its variant live in two cells; the files spell them as one', () => {
    // THE JOIN NOBODY WRITES DOWN: the ERP exports "3010-005424" | "01" and the
    // archive files the part under "3010-005424-01". Neither side can find the
    // other unless the row is read as one string.
    const s = scan('Item No.,Variant,Quantity\n3010-005424,01,6\n');
    assert.strictEqual(s.hits, 1);
});

test("a Dutch export is semicolon-separated, and its \"01\" is a variant, not the number one", () => {
    // Two ways the same file used to score zero: the reader handed the whole
    // row back as one column, and it helpfully turned "01" into 1.
    const s = scan('Item No.;Variant;Quantity;Material;Height\n3010-005424;01;6;EN AW-6082 T6;8\n');
    assert.strictEqual(s.hits, 1, 'the semicolon is a delimiter here');
    assert.strictEqual(s.columns, 5, 'and the column count says the split really happened');
});

test('a stripped export that lost the variant column names no parts at all', () => {
    // THE LIVE CASE, and the reason "biggest wins" was wrong: this file is two
    // kilobytes LARGER than the real bill of materials and carries three
    // populated columns instead of twelve — no thickness, and a key column that
    // no longer identifies anything.
    const stripped = scan('cadfile,Quantity,Material\n3010-005424,6,EN AW-6082 T6\n3010-007646,2,EN AW-6082 T6\n');
    assert.strictEqual(stripped.hits, 0);

    const real = scan('Item No.,Variant,Quantity,Material,Height\n3010-005424,01,6,EN AW-6082 T6,8\n');
    assert.ok(real.hits > stripped.hits, 'so the real table wins on what it says, not on bytes');
});

test('a file whose headers already ARE the target columns is a line list, not a table', () => {
    const list = scan('cadfile;Material;Thickness;Quantity;Orientation\n3010-005424-01.dxf;Aluminium 6082;10;16;8\n');
    assert.strictEqual(list.lineList, true);
    assert.strictEqual(list.hits, 1);

    // …and a bill of materials is not one, however many parts it names.
    const bom = scan('Item No.,Variant,Quantity,Material,Height\n3010-005424,01,6,EN AW-6082 T6,8\n');
    assert.strictEqual(bom.lineList, false);
});

test('a cadfile column alone is not enough to call something a line list', () => {
    // One recognisable header on a sheet of something else is a coincidence;
    // the supporting vocabulary is what makes it a claim.
    assert.strictEqual(looksLikeLineList(['cadfile', 'opmerking']), false);
    assert.strictEqual(looksLikeLineList(['cadfile', 'Quantity', 'Material']), true);
    assert.strictEqual(looksLikeLineList(['cadfile', 'aantal', 'dikte']), true, 'Dutch headers count too');
    assert.strictEqual(looksLikeLineList([]), false);
});

test('a part key too short to identify anything never scores a hit', () => {
    // "a1" appears in half of every workbook. A rule that let it count would
    // hand the bill-of-materials crown to whichever file had the most text.
    const s = scan('naam,telefoon\nJan,0612345678\n', ['a1', 'b2']);
    assert.strictEqual(s.hits, 0);
});

test('bytes that are not a workbook, or too many of them, are a null — never a guess', () => {
    assert.strictEqual(scanSheet(Buffer.alloc(0), { partKeys: KEYS }), null);
    assert.strictEqual(scanSheet(null, { partKeys: KEYS }), null);
    assert.strictEqual(
        scanSheet(Buffer.alloc(MAX_SCAN_BYTES + 1), { partKeys: KEYS }),
        null,
        'a spreadsheet past the ceiling is not one, and opening it to find out is the expensive way',
    );
});

test('every count is per WORKBOOK, so a part on two sheets is still one part', () => {
    const s = scan([
        'Item No.,Variant,Quantity',
        '3010-005424,01,6',
        '3010-005424,01,10',
    ].join('\n'));
    assert.strictEqual(s.hits, 1, 'a repeated part is one part named, not two');
    assert.strictEqual(s.rows, 2, 'though both rows are still rows');
});

// ── what the sheet lists and the package did not carry ──────────────────────

test('the sheet names the parts that never arrived, from the column that proved itself', () => {
    // THE PLATE FROM THE REAL ORDER: 3010-007033-01 is on the bill of materials
    // and its folder in the archive is empty. Nothing about the FILES can say
    // that; only the sheet knows the part was ordered at all.
    const s = scan([
        'Item No.;Variant;Drawing;Quantity;Material;Height',
        '3010-005424;01;3060-000435;6;EN AW-6082 T6;8',
        '3010-007033;01;3060-000435;1;EN AW-6082 T6;10',
        '3010-007646;01;3060-000436;2;EN AW-6082 T6;10',
    ].join('\n'), ['3010-005424-01', '3010-007646-01']);
    assert.strictEqual(s.hits, 2);
    assert.deepStrictEqual(s.unmatched, ['3010-007033-01']);
    assert.strictEqual(s.unmatchedCount, 1);
});

test('no row matched means no claim — an unreadable sheet invents no order', () => {
    // The column is LEARNED from a row we recognised. Without one there is
    // nothing to learn from, and harvesting number-shaped tokens out of a
    // spreadsheet would report drawing numbers and lengths as missing parts.
    const s = scan('Item No.;Variant;Quantity\n9999-111111;01;6\n', ['3010-005424-01']);
    assert.strictEqual(s.hits, 0);
    assert.deepStrictEqual(s.unmatched, []);
});

test('only the article column is read — the other numbers on the row are not parts', () => {
    // Drawing numbers, positions, lengths and an order reference all look like
    // part numbers to a regex. The proven column is the whole defence.
    const s = scan([
        'Item No.;Variant;Drawing;Position;Quantity;Length',
        '3010-005424;01;3060-000435;1;6;980',
        '3010-007033;01;3074-000177;2;1;370',
    ].join('\n'), ['3010-005424-01']);
    assert.deepStrictEqual(s.unmatched, ['3010-007033-01'],
        'the drawing numbers 3060-000435 / 3074-000177 are not missing parts');
});

test('a single-cell article column needs no variant beside it', () => {
    const s = scan('cadfile;Quantity\n3010-005424-01;6\n3010-007033-01;1\n', ['3010-005424-01']);
    assert.deepStrictEqual(s.unmatched, ['3010-007033-01']);
});
