'use strict';
/**
 * The workbook reader: one table per sheet, our caps, loud on every limit.
 * Fixtures are synthetic and built here: workbooks through SheetJS in memory,
 * CSV as strings.
 */

// A sheet's wall-clock dates must survive a server in another timezone.
process.env.TZ = 'America/Los_Angeles';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('@e965/xlsx');
const JSZip = require('jszip');
const { isoToSerial } = require('../../dataEngine/sources/spreadsheetFile/cells');
const { readWorkbookTables } = require('./workbook');

const LIMITS = Object.freeze({
    maxRows: 1_000_000, maxColumns: 1000, maxFileBytes: 25 * 1024 * 1024, maxUncompressedBytes: 256 * 1024 * 1024, maxSheets: 50,
});
const limits = (over = {}) => ({ ...LIMITS, ...over });

function book(sheets, { hidden = [], bookType = 'xlsx' } = {}) {
    const wb = XLSX.utils.book_new();
    for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
    wb.Workbook = { Sheets: Object.keys(sheets).map(n => ({ name: n, Hidden: hidden.includes(n) ? 1 : 0 })) };
    return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType }));
}

const csv = (text) => Buffer.from(text, 'utf8');
const read = (buf, opts = {}) => readWorkbookTables(buf, { limits: limits(), ...opts });
const rejects = (promise, errorClass, re) => assert.rejects(promise, (e) => {
    assert.equal(e.errorClass, errorClass, e.message);
    if (re) assert.match(e.message, re);
    return true;
});

test('a multi-sheet workbook gives one table per sheet, in file order', async () => {
    const buf = book({ People: [['Name', 'Score'], ['Ada', 3], ['Bo', 5]], Teams: [['Team'], ['Red']] });
    const r = await read(buf);
    assert.equal(r.format, 'xlsx');
    assert.deepEqual(r.sheets.map(s => s.name), ['People', 'Teams']);
    assert.deepEqual(r.sheets[0].columns, [
        { key: 'Name', label: 'Name', type: 'text' },
        { key: 'Score', label: 'Score', type: 'number' },
    ]);
    assert.deepEqual(r.sheets[0].rows, [{ Name: 'Ada', Score: 3 }, { Name: 'Bo', Score: 5 }]);
    assert.deepEqual(r.sheets[1].rows, [{ Team: 'Red' }]);
    assert.equal(r.provenance, null);
});

test('a hidden sheet is skipped unless skipHiddenSheets is off, or the step names it', async () => {
    const buf = book({ Shown: [['A'], [1]], Secret: [['B'], [2]] }, { hidden: ['Secret'] });
    const skip = await read(buf);
    assert.equal(skip.sheets[1].skipped, 'hidden');
    assert.deepEqual(skip.sheets[1].rows, []);
    const keep = await read(buf, { skipHiddenSheets: false });
    assert.equal(keep.sheets[1].skipped, undefined);
    assert.deepEqual(keep.sheets[1].rows, [{ B: 2 }]);
    const named = await read(buf, { sheets: ['secret'] });
    assert.equal(named.sheets[0].skipped, 'not_selected');
    assert.deepEqual(named.sheets[1].rows, [{ B: 2 }]);
});

test('sheets: "first" reads the first sheet with data and leaves the rest', async () => {
    const buf = book({ Blank: [[]], One: [['A'], [1]], Two: [['A'], [2]] });
    const r = await read(buf, { sheets: 'first' });
    assert.deepEqual(r.sheets.map(s => s.skipped), ['empty', undefined, 'not_selected']);
});

test('a named sheet that is not there is an error that names the sheets', async () => {
    const buf = book({ One: [['A'], [1]] });
    await rejects(read(buf, { sheets: ['Nope'] }), 'table_sheet_missing', /"Nope".*"One"/);
});

test('a provenance sheet is read as key/value pairs and is not a table', async () => {
    const buf = book({
        Data: [['A'], [1]],
        'Read Me': [['Source', 'Synthetic export'], ['Period', '2026-Q1'], [], ['Owner', 'Team A']],
    });
    const r = await read(buf);
    assert.deepEqual(r.provenance, { Source: 'Synthetic export', Period: '2026-Q1', Owner: 'Team A' });
    assert.equal(r.sheets[1].skipped, 'provenance');
    const none = await read(buf, { provenanceSheet: 'none' });
    assert.equal(none.provenance, null);
    assert.equal(none.sheets[1].skipped, undefined);
    const exact = await read(book({ D: [['A'], [1]], Notes: [['k', 'v']] }), { provenanceSheet: 'Notes' });
    assert.deepEqual(exact.provenance, { k: 'v' });
});

test('provenance is capped at 200 pairs, keys at 100 characters, values at 500', async () => {
    const aoa = Array.from({ length: 250 }, (_, i) => [`k${i}`, 'v']);
    aoa[0] = ['k'.repeat(150), 'x'.repeat(900)];
    const r = await read(book({ D: [['A'], [1]], About: aoa }));
    const keys = Object.keys(r.provenance);
    assert.equal(keys.length, 200);
    assert.equal(keys[0].length, 100);
    assert.equal(r.provenance[keys[0]].length, 500);
});

test('headerRow reads the header further down and ignores the rows above it', async () => {
    const buf = book({ S: [['Report title'], ['Name', 'Qty'], ['Ada', 2]] });
    const r = await read(buf, { headerRow: 2 });
    assert.deepEqual(r.sheets[0].columns.map(c => c.key), ['Name', 'Qty']);
    assert.deepEqual(r.sheets[0].rows, [{ Name: 'Ada', Qty: 2 }]);
});

test('blank and duplicate headers get stable keys; empty columns without a header are dropped', async () => {
    const buf = book({ S: [['  Total  ', 'Total', null, 'Total', '', 'Name  of   it'], [1, 2, 3, 4, null, 'x']] });
    const r = await read(buf);
    assert.deepEqual(r.sheets[0].columns.map(c => c.key), ['Total', 'Total (2)', 'Column C', 'Total (3)', 'Name of it']);
    assert.deepEqual(r.sheets[0].rows, [{ Total: 1, 'Total (2)': 2, 'Column C': 3, 'Total (3)': 4, 'Name of it': 'x' }]);
});

test('a header longer than 200 characters is cut', async () => {
    const r = await read(book({ S: [['h'.repeat(300)], [1]] }));
    assert.equal(r.sheets[0].columns[0].key.length, 200);
});

test('dates come back as ISO strings with the wall clock as UTC, whatever the server timezone', async () => {
    const wb = XLSX.utils.book_new();
    const ws = {
        A1: { t: 's', v: 'When' }, B1: { t: 's', v: 'Stamp' },
        A2: { t: 'n', v: isoToSerial('2026-01-15'), z: 'yyyy-mm-dd' },
        B2: { t: 'n', v: isoToSerial('2026-01-15T13:45:30.000Z'), z: 'yyyy-mm-dd hh:mm:ss' },
        '!ref': 'A1:B2',
    };
    XLSX.utils.book_append_sheet(wb, ws, 'D');
    const r = await read(Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
    assert.deepEqual(r.sheets[0].rows, [{ When: '2026-01-15', Stamp: '2026-01-15T13:45:30.000Z' }]);
    assert.deepEqual(r.sheets[0].columns.map(c => c.type), ['date', 'datetime']);
});

test('numbers, booleans, text and mixed columns get their storage type; blank rows are dropped', async () => {
    const buf = book({ S: [['n', 'b', 't', 'm', 'e'], [1.5, true, 'a', 1, null], [], [2, false, 'b', 'x', null]] });
    const r = await read(buf);
    assert.deepEqual(r.sheets[0].columns.map(c => c.type), ['number', 'boolean', 'text', 'mixed', 'empty']);
    assert.equal(r.sheets[0].rows.length, 2);
    assert.deepEqual(r.sheets[0].rows[1], { n: 2, b: false, t: 'b', m: 'x', e: null });
});

test('text that looks like a number stays text in a workbook', async () => {
    const r = await read(book({ S: [['code'], ['0123'], ['0456']] }));
    assert.equal(r.sheets[0].columns[0].type, 'text');
    assert.deepEqual(r.sheets[0].rows.map(x => x.code), ['0123', '0456']);
});

test('an ods and an xls file read the same way', async () => {
    const aoa = { S: [['A', 'B'], ['x', 2]] };
    for (const bookType of ['ods', 'xls']) {
        const r = await read(book(aoa, { bookType }));
        assert.equal(r.format, bookType);
        assert.deepEqual(r.sheets[0].rows, [{ A: 'x', B: 2 }], bookType);
    }
});

test('csv: ";" delimiter and a decimal comma become numbers; leading zeros keep a column as text', async () => {
    const r = await read(csv('name;amount;code\nAda;1.234,50;0123\nBo;12,5;0456\nCy;3;7\n'), { filename: 'sales.csv' });
    assert.equal(r.format, 'csv');
    const [sheet] = r.sheets;
    assert.equal(sheet.name, 'sales');
    assert.deepEqual(sheet.columns.map(c => [c.key, c.type]), [['name', 'text'], ['amount', 'number'], ['code', 'text']]);
    assert.deepEqual(sheet.rows[0], { name: 'Ada', amount: 1234.5, code: '0123' });
    assert.equal(sheet.rows[1].amount, 12.5);
});

test('csv: a tab delimiter is sniffed, and an explicit one wins', async () => {
    const r = await read(csv('a\tb\n1\t2\n'));
    assert.deepEqual(r.sheets[0].rows, [{ a: 1, b: 2 }]);
    const forced = await read(csv('a|b,c\n1|2,3\n'), { delimiter: '|' });
    assert.deepEqual(forced.sheets[0].columns.map(c => c.key), ['a', 'b,c']);
});

test('csv: a formula-prefixed text cell is read without the apostrophe the writer added', async () => {
    const r = await read(csv("note\n'=1+1\n'-dash\nplain\n"));
    assert.deepEqual(r.sheets[0].rows.map(x => x.note), ['=1+1', '-dash', 'plain']);
});

test('csv: ISO dates are recognised, a mostly-numeric column with a stray word is kept mixed', async () => {
    const lines = ['d,v'];
    for (let i = 1; i <= 25; i += 1) lines.push(`2026-01-${String(i).padStart(2, '0')},${i}`);
    lines.push('2026-02-30,oops');
    const r = await read(csv(lines.join('\n')));
    assert.equal(r.sheets[0].columns[0].type, 'text');       // 2026-02-30 is not a day
    assert.equal(r.sheets[0].columns[1].type, 'mixed');
    assert.equal(r.sheets[0].rows[25].v, 'oops');
    const ok = await read(csv('d\n2026-01-01\n2026-01-02\n'));
    assert.equal(ok.sheets[0].columns[0].type, 'date');
});

test('csv: a UTF-16 file with a byte order mark reads, an empty one is refused', async () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n1,2\n', 'utf16le')]);
    const r = await read(buf);
    assert.deepEqual(r.sheets[0].rows, [{ a: 1, b: 2 }]);
    await rejects(read(Buffer.alloc(0)), 'table_source_unsupported', /empty/);
});

test('a csv with only blank lines is an empty sheet, not a table', async () => {
    const r = await read(csv('\n\n'));
    assert.equal(r.sheets[0].skipped, 'empty');
});

test('too many rows is a loud table_too_large that names the cap and the variable', async () => {
    const rows = [['A'], ...Array.from({ length: 12 }, (_, i) => [i])];
    await rejects(read(book({ Big: rows }), { limits: limits({ maxRows: 10 }) }), 'table_too_large', /"Big".*10 rows.*AUTOMATION_TABLE_MAX_ROWS/);
    const lines = ['a', ...Array.from({ length: 12 }, (_, i) => String(i))];
    await rejects(read(csv(lines.join('\n')), { limits: limits({ maxRows: 10 }) }), 'table_too_large', /AUTOMATION_TABLE_MAX_ROWS/);
    // exactly at the cap is fine, and 0 means unlimited
    const exact = await read(book({ S: [['A'], ...Array.from({ length: 10 }, (_, i) => [i])] }), { limits: limits({ maxRows: 10 }) });
    assert.equal(exact.sheets[0].rows.length, 10);
    const unlimited = await read(book({ S: rows }), { limits: limits({ maxRows: 0 }) });
    assert.equal(unlimited.sheets[0].rows.length, 12);
});

test('too many columns is a loud table_too_many_columns', async () => {
    const wide = [Array.from({ length: 8 }, (_, i) => `c${i}`), Array.from({ length: 8 }, (_, i) => i)];
    await rejects(read(book({ W: wide }), { limits: limits({ maxColumns: 5 }) }), 'table_too_many_columns', /AUTOMATION_TABLE_MAX_COLUMNS/);
    await rejects(read(csv('a,b,c,d,e,f\n1,2,3,4,5,6\n'), { limits: limits({ maxColumns: 5 }) }), 'table_too_many_columns');
});

test('more sheets than the cap: the rest are skipped "limit" with a warning', async () => {
    const buf = book({ A: [['x'], [1]], B: [['x'], [1]], C: [['x'], [1]] });
    const r = await read(buf, { limits: limits({ maxSheets: 2 }) });
    assert.deepEqual(r.sheets.map(s => s.skipped), [undefined, undefined, 'limit']);
    assert.match(r.warnings.join(' '), /AUTOMATION_TABLE_MAX_SHEETS/);
});

test('a file over maxFileBytes is table_source_too_large', async () => {
    await rejects(read(csv('a\n1\n'), { limits: limits({ maxFileBytes: 3 }) }), 'table_source_too_large', /AUTOMATION_TABLE_MAX_FILE_BYTES/);
});

test('a format that contradicts the bytes is refused, and xlsx/xlsm are one family', async () => {
    const xlsx = book({ S: [['A'], [1]] });
    await rejects(read(xlsx, { format: 'csv' }), 'table_source_unsupported', /\.csv.*\.xlsx/);
    await rejects(read(xlsx, { format: 'ods' }), 'table_source_unsupported');
    await rejects(read(csv('a,b\n1,2\n'), { format: 'xlsx' }), 'table_source_unsupported');
    const ok = await read(xlsx, { format: 'xlsm' });
    assert.equal(ok.format, 'xlsx');
    assert.equal((await read(xlsx, { format: 'auto' })).format, 'xlsx');
});

test('binary that is neither a package nor text is refused', async () => {
    const bin = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100, 0), Buffer.from('rest')]);
    await rejects(read(bin), 'table_source_unsupported', /binary/);
});

test('a zip that is not a spreadsheet (no workbook part) is refused', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('word/document.xml', '<w:document/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await rejects(read(buf), 'table_source_unsupported', /not a spreadsheet/);
});

test('a text file renamed to a package is not parsed as a workbook', async () => {
    await rejects(read(Buffer.from('PK\u0003\u0004 not really a zip at all')), 'table_source_rejected');
});

test('a part with a DOCTYPE or ENTITY is rejected before SheetJS sees it', async () => {
    const real = await JSZip.loadAsync(book({ S: [['A'], [1]] }));
    real.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa">]><worksheet>&a;</worksheet>');
    const bad = await real.generateAsync({ type: 'nodebuffer' });
    await rejects(read(bad), 'table_source_rejected', /document type or entity/);
    // the same declaration in UTF-16
    const real2 = await JSZip.loadAsync(book({ S: [['A'], [1]] }));
    real2.file('xl/sharedStrings.xml', Buffer.from('<!ENTITY a "b">', 'utf16le'));
    await rejects(read(await real2.generateAsync({ type: 'nodebuffer' })), 'table_source_rejected');
});

test('a package that unpacks past the cap is rejected from its declared sizes', async () => {
    const real = await JSZip.loadAsync(book({ S: [['A'], [1]] }));
    real.file('xl/worksheets/big.xml', '<worksheet>' + ' '.repeat(300_000) + '</worksheet>');
    const buf = await real.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await rejects(read(buf, { limits: limits({ maxUncompressedBytes: 100_000 }) }), 'table_source_rejected', /AUTOMATION_TABLE_MAX_UNCOMPRESSED_BYTES/);
    // 0 = unlimited
    assert.equal((await read(buf, { limits: limits({ maxUncompressedBytes: 0 }) })).sheets.length, 1);
});

test('a part compressed more than 200:1 above 10 MB is rejected', async () => {
    const real = await JSZip.loadAsync(book({ S: [['A'], [1]] }));
    real.file('xl/media/zeros.bin', Buffer.alloc(11 * 1024 * 1024));
    const buf = await real.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await rejects(read(buf), 'table_source_rejected', /compressed far more/);
});

test('a package with more than 10 000 parts is rejected before it is opened', async () => {
    const zip = new JSZip();
    for (let i = 0; i < 10_001; i += 1) zip.file(`p/${i}.txt`, '');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await rejects(read(buf), 'table_source_rejected', /10,000 parts/);
});

test('error messages name sheets and caps, never a cell value', async () => {
    const rows = [['A'], ...Array.from({ length: 5 }, () => ['secret-value-xyz'])];
    await assert.rejects(read(book({ S: rows }), { limits: limits({ maxRows: 2 }) }), (e) => {
        assert.doesNotMatch(e.message, /secret-value-xyz/);
        return true;
    });
});

/** Patch the uncompressed-size fields of every entry named `name` (local header and central directory). */
function lieAboutSize(buf, name, declared) {
    const out = Buffer.from(buf);
    const nameBuf = Buffer.from(name);
    for (let i = 0; i + 46 < out.length; i += 1) {
        const sig = out.readUInt32LE(i);
        const nameLen = sig === 0x04034b50 ? out.readUInt16LE(i + 26) : sig === 0x02014b50 ? out.readUInt16LE(i + 28) : -1;
        const nameAt = sig === 0x04034b50 ? i + 30 : i + 46;
        if (nameLen !== nameBuf.length || out.compare(nameBuf, 0, nameLen, nameAt, nameAt + nameLen) !== 0) continue;
        out.writeUInt32LE(declared, sig === 0x04034b50 ? i + 22 : i + 24);
    }
    return out;
}

test('a part that lies about its uncompressed size is cut off, as table_source_rejected', async () => {
    const real = await JSZip.loadAsync(book({ S: [['A'], [1]] }));
    real.file('xl/media/lie.bin', Buffer.alloc(40 * 1024 * 1024));
    const honest = await real.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const lying = lieAboutSize(honest, 'xl/media/lie.bin', 1000);
    const before = process.memoryUsage().rss;
    await rejects(read(lying), 'table_source_rejected', /more than it declares|compressed far more/);
    assert.ok(process.memoryUsage().rss - before < 25 * 1024 * 1024, 'the part must not be inflated in full');
});

test('a non-XML part is counted against the cap too', async () => {
    const real = await JSZip.loadAsync(book({ S: [['A'], [1]] }));
    real.file('xl/media/blob.bin', Buffer.alloc(300_000, 7));
    const buf = await real.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const honest = lieAboutSize(buf, 'xl/media/blob.bin', 10);
    await rejects(read(honest, { limits: limits({ maxUncompressedBytes: 100_000 }) }), 'table_source_rejected');
});

test('a DOCTYPE that straddles two stream chunks is still found', async () => {
    const real = await JSZip.loadAsync(book({ S: [['A'], [1]] }));
    // 16 KiB is the stream chunk size; park the needle across that border
    real.file('xl/worksheets/sheet1.xml', '<worksheet>' + 'x'.repeat(16 * 1024 - 15) + '<!DOCTYPE x></worksheet>');
    await rejects(read(await real.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })), 'table_source_rejected', /document type or entity/);
});
