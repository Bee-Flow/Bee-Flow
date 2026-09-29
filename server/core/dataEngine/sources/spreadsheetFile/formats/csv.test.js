/**
 * CSV: the sniff finds what the file's own tool wrote (delimiter, BOM, EOL,
 * encoding, decimal), the parser is RFC 4180 with a cap, an edit leaves
 * every untouched record byte-identical, and a formula-shaped text is
 * written with the `'` prefix a csv needs to stay text in Excel — and read
 * without it again.
 */
const test = require('node:test');
const assert = require('node:assert');
const csv = require('./csv');

const BOM = '﻿';
const DUTCH = Buffer.from(`${BOM}Naam;Bedrag;Datum;Actief\r\n"Acme; BV";1.234,56;15-01-2026;ja\r\nBeta;10,5;16-01-2026;nee\r\n"Multi\r\nline";7;17-01-2026;ja\r\n`, 'utf8');

test('sniff: semicolon, BOM, CRLF, utf-8 and a decimal comma', () => {
    assert.deepEqual(csv.sniff(DUTCH), { delimiter: ';', quote: '"', bom: true, eol: '\r\n', encoding: 'utf-8', decimal: ',' });
});

test('sniff: tab, comma (with a quoted semicolon inside), pipe, LF, decimal point', () => {
    assert.equal(csv.sniff(Buffer.from('a\tb\tc\n1\t2\t3\n')).delimiter, '\t');
    const comma = csv.sniff(Buffer.from('name,note,amount\n"x; y","a,b",1,234.5\nz,w,2.5\n'));
    assert.equal(comma.delimiter, ',');
    assert.equal(comma.eol, '\n');
    assert.equal(comma.bom, false);
    assert.equal(comma.decimal, '.');
    assert.equal(csv.sniff(Buffer.from('a|b\n1|2\n')).delimiter, '|');
    assert.equal(csv.sniff(Buffer.from('single column\nonly\n')).delimiter, ',');
    // decimal commas in the data do not fool the delimiter: consistency with the header wins
    assert.equal(csv.sniff(Buffer.from('Naam;Bedrag\nA;1,5\nB;2,5\nC;3,5\n')).delimiter, ';');
});

test('sniff: windows-1252 bytes fall back from utf-8, and utf-16le is read by its BOM', () => {
    const cp = Buffer.concat([Buffer.from('Naam;Stad\nRen'), Buffer.from([0xe9]), Buffer.from(';Z'), Buffer.from([0xfc]), Buffer.from('rich\n')]);
    const s = csv.sniff(cp);
    assert.equal(s.encoding, 'windows-1252');
    assert.equal(csv.decode(cp).text, 'Naam;Stad\nRené;Zürich\n');
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\tb\r\n1\t2\r\n', 'utf16le')]);
    const s16 = csv.sniff(u16);
    assert.equal(s16.encoding, 'utf-16le');
    assert.equal(s16.delimiter, '\t');
    assert.equal(s16.bom, true);
});

test('parseRecords: quotes, doubled quotes, embedded line breaks, a last record without EOL, blank lines kept', () => {
    const { records, truncated } = csv.parseRecords('a,b\n"x ""q"" y","1\n2"\n\n"last",z', ',');
    assert.equal(truncated, false);
    assert.deepEqual(records.map(r => r.fields), [['a', 'b'], ['x "q" y', '1\n2'], [''], ['last', 'z']]);
    assert.deepEqual(records.map(r => r.raw), ['a,b\n', '"x ""q"" y","1\n2"\n', '\n', '"last",z']);
    assert.equal(records.map(r => r.raw).join(''), 'a,b\n"x ""q"" y","1\n2"\n\n"last",z');
    assert.equal(csv.isBlankRecord(records[2]), true);
});

test('parseRecords stops at the record and cell caps and says so', () => {
    const text = 'h1,h2\n1,2\n3,4\n5,6\n';
    const byRecords = csv.parseRecords(text, ',', { maxRecords: 2 });
    assert.equal(byRecords.records.length, 2);
    assert.equal(byRecords.truncated, true);
    const byCells = csv.parseRecords(text, ',', { maxCells: 3 });
    assert.equal(byCells.records.length, 2);
    assert.equal(byCells.truncated, true);
    assert.equal(csv.parseRecords(text, ',', { maxRecords: 4 }).truncated, false);
});

test('readSheet: header row, typed-as-strings cells, blank rows dropped, row numbers kept', async () => {
    const r = await csv.readSheet(DUTCH, { headerRow: 1, maxRows: 100, maxCols: 100 });
    assert.deepEqual(r.header, ['Naam', 'Bedrag', 'Datum', 'Actief']);
    assert.deepEqual(r.rows, [['Acme; BV', '1.234,56', '15-01-2026', 'ja'], ['Beta', '10,5', '16-01-2026', 'nee'], ['Multi\r\nline', '7', '17-01-2026', 'ja']]);
    assert.deepEqual(r.rowNumbers, [2, 3, 4]);
    assert.equal(r.lastDataRow, 4);
    assert.equal(r.truncated, false);
    assert.equal(r.sheet, null);
    assert.equal(r.formulaCols.size, 0);
    assert.equal(r.csv.delimiter, ';');
    const withBlank = await csv.readSheet(Buffer.from('titel\nA,B\n\n1,\n,\n2,3\n'), { headerRow: 2, maxRows: 100, maxCols: 100 });
    assert.deepEqual(withBlank.header, ['A', 'B']);
    assert.deepEqual(withBlank.rows, [['1', null], ['2', '3']]);
    assert.deepEqual(withBlank.rowNumbers, [4, 6]);
    assert.equal(withBlank.lastDataRow, 6);
});

test('readSheet: the row cap sets truncated, and fields past the header are ignored with a warning', async () => {
    const big = `A,B\n${Array.from({ length: 30 }, (_, i) => `${i},x`).join('\n')}\n`;
    const r = await csv.readSheet(Buffer.from(big), { headerRow: 1, maxRows: 10, maxCols: 100 });
    assert.equal(r.rows.length, 10);
    assert.equal(r.truncated, true);
    assert.equal(r.lastDataRow, 11);
    const wide = await csv.readSheet(Buffer.from('A,B,,\n1,2,3,4\n'), { headerRow: 1, maxRows: 10, maxCols: 100 });
    assert.deepEqual(wide.header, ['A', 'B']);
    assert.deepEqual(wide.rows, [['1', '2']]);
    assert.match(wide.warnings[0], /ignored/);
    const capped = await csv.readSheet(Buffer.from('A,B,C\n1,2,3\n'), { headerRow: 1, maxRows: 10, maxCols: 2 });
    assert.deepEqual(capped.header, ['A', 'B']);
    assert.match(capped.warnings[0], /first 2 of 3/);
});

test('readSheet: a blank header row is a 422 header_missing', async () => {
    for (const buf of [Buffer.from(''), Buffer.from('\n\n'), Buffer.from(',,\n1,2,3\n')]) {
        await assert.rejects(csv.readSheet(buf, { headerRow: 1, maxRows: 10, maxCols: 10 }), (e) => e.code === 'header_missing' && e.status === 422);
    }
    await assert.rejects(csv.readSheet(Buffer.from('A,B\n1,2\n'), { headerRow: 5, maxRows: 10, maxCols: 10 }), (e) => e.code === 'header_missing');
});

test('serialise reproduces the original bytes when nothing was touched', () => {
    for (const buf of [
        DUTCH,
        Buffer.from('a,b\n1,2'),
        Buffer.from('a,b\r\n"x,y",2\r\n\r\n'),
        Buffer.concat([Buffer.from('Naam;Stad\nRen'), Buffer.from([0xe9]), Buffer.from(';Z'), Buffer.from([0xfc, 0x80, 0x81]), Buffer.from('rich\n')]),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\tb\r\n1\t2\r\n', 'utf16le')]),
    ]) {
        const sniffed = csv.sniff(buf);
        const { records } = csv.parseRecords(csv.decode(buf).text, sniffed.delimiter);
        assert.ok(csv.serialise(records, sniffed).equals(buf));
    }
});

test('editInPlace: an update rewrites only its record, byte for byte', async () => {
    const columns = { 1: { type: 'number' }, 2: { type: 'date', dateFormat: 'dd-mm-yyyy' }, 3: { type: 'bool' } };
    const { buffer, appended, lastDataRow } = await csv.editInPlace(DUTCH, {
        headerRow: 1, columns, csv: csv.sniff(DUTCH),
        ops: [{ op: 'update', row: 3, cells: { 1: 11.5, 2: new Date(Date.UTC(2026, 0, 20)), 3: false } }],
    });
    const before = DUTCH.toString('utf8');
    const after = buffer.toString('utf8');
    assert.equal(after, before.replace('Beta;10,5;16-01-2026;nee\r\n', 'Beta;11,5;20-01-2026;FALSE\r\n'));
    assert.deepEqual(appended, []);
    assert.equal(lastDataRow, 4);
    assert.ok(buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
});

test('editInPlace: append lands after the last data record and terminates a file that had no final newline', async () => {
    const noEol = Buffer.from('A;B\r\n1;2');
    const r = await csv.editInPlace(noEol, { headerRow: 1, ops: [{ op: 'append', cells: { 0: 'x; y', 1: 'say "hi"' } }] });
    assert.equal(r.buffer.toString('utf8'), 'A;B\r\n1;2\r\n"x; y";"say ""hi"""\r\n');
    assert.deepEqual(r.appended, [3]);
    assert.equal(r.lastDataRow, 3);
    // trailing blank lines: the new row takes the first blank line, nothing lands below it
    const trailing = Buffer.from('A,B\n1,2\n\n\n');
    const t = await csv.editInPlace(trailing, { headerRow: 1, ops: [{ op: 'append', cells: { 0: '3', 1: '4' } }] });
    assert.equal(t.buffer.toString('utf8'), 'A,B\n1,2\n3,4\n\n');
    assert.deepEqual(t.appended, [3]);
    // a formula-shaped text is pinned as text with a `'` (its own test below); a leading space is quoted
    const f = await csv.editInPlace(Buffer.from('A,B\n1,2\n'), { headerRow: 1, ops: [{ op: 'append', cells: { 0: '=SUM(1)', 1: ' lead' } }] });
    assert.equal(f.buffer.toString('utf8'), "A,B\n1,2\n'=SUM(1),\" lead\"\n");
});

test('a formula-shaped text is written with a `\'` prefix and read without it: Excel never evaluates it, the mirror never shows the apostrophe', async () => {
    // WRITE: every trigger character, in a text-shaped column only
    for (const v of ['=cmd|\'/C calc\'!A0', '+31 6 1234 5678', '-', '@SUM(A1)', '\tx', '\rx']) {
        assert.equal(csv.formatField(v, { type: 'text' }), `'${v}`, JSON.stringify(v));
        assert.equal(csv.formatField(v, {}), `'${v}`, 'no declared type is text-shaped');
        assert.equal(csv.formatField(v, { type: 'select' }), `'${v}`);
    }
    assert.equal(csv.formatField('x=1', { type: 'text' }), 'x=1', 'only a LEADING trigger');
    assert.equal(csv.formatField(-5, { type: 'number' }), '-5', 'a number is a number');
    assert.equal(csv.formatField('-5', { type: 'number' }), '-5', 'a number column is never prefixed, whatever the spelling');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5)), { type: 'date' }), '2026-01-05');
    // through the editor: the row lands as text Excel shows as text, the other rows untouched
    const r = await csv.editInPlace(Buffer.from('Naam;Tel\r\nAcme;0612\r\n'), {
        headerRow: 1, columns: { 0: { type: 'text' }, 1: { type: 'text' } },
        ops: [{ op: 'append', cells: { 0: '=HYPERLINK("http://evil")', 1: '+31 6 1234' } }, { op: 'update', row: 2, cells: { 1: '-' } }],
    });
    assert.equal(r.buffer.toString('utf8'), "Naam;Tel\r\nAcme;'-\r\n\"'=HYPERLINK(\"\"http://evil\"\")\";'+31 6 1234\r\n", 'the prefix goes INSIDE the RFC quoting');
    // READ: the prefix comes off again — the copy shows what was typed, and a
    // second write of what was read is the same bytes (an echo is a no-op)
    const back = await csv.readSheet(r.buffer, { headerRow: 1, maxRows: 100, maxCols: 100 });
    assert.deepEqual(back.rows, [['Acme', '-'], ['=HYPERLINK("http://evil")', '+31 6 1234']]);
    assert.equal(csv.formatField(back.rows[1][0], { type: 'text' }), "'=HYPERLINK(\"http://evil\")");
    // only ONE apostrophe, and only in front of a trigger: other apostrophes are content
    assert.equal(csv.unprefixField("'=1"), '=1');
    assert.equal(csv.unprefixField("'abc"), "'abc");
    assert.equal(csv.unprefixField("''=1"), "''=1");
    assert.equal(csv.unprefixField("'s-Hertogenbosch"), "'s-Hertogenbosch");
    const plain = await csv.readSheet(Buffer.from("Plaats\n's-Hertogenbosch\n'-\n"), { headerRow: 1, maxRows: 10, maxCols: 10 });
    assert.deepEqual(plain.rows, [["'s-Hertogenbosch"], ['-']]);
});

test('editInPlace: delete removes the record; updates, deletes and appends in one batch keep their row numbers', async () => {
    const buf = Buffer.from('A,B\n1,a\n2,b\n3,c\n');
    const r = await csv.editInPlace(buf, {
        headerRow: 1,
        ops: [
            { op: 'update', row: 4, cells: { 1: 'C' } },
            { op: 'delete', row: 2 },
            { op: 'append', cells: { 0: '4', 1: 'd' } },
            { op: 'delete', row: 3 },
        ],
    });
    assert.equal(r.buffer.toString('utf8'), 'A,B\n3,C\n4,d\n');
    assert.deepEqual(r.appended, [3]);
    assert.equal(r.lastDataRow, 3);
});

test('editInPlace refuses a row that is gone, a column outside the header and a blank header', async () => {
    const buf = Buffer.from('A,B\n1,a\n');
    await assert.rejects(csv.editInPlace(buf, { headerRow: 1, ops: [{ op: 'update', row: 5, cells: { 0: 'x' } }] }), (e) => e.code === 'spreadsheet_not_found' && e.status === 404);
    await assert.rejects(csv.editInPlace(buf, { headerRow: 1, ops: [{ op: 'update', row: 1, cells: { 0: 'x' } }] }), (e) => e.code === 'spreadsheet_not_found');
    await assert.rejects(csv.editInPlace(buf, { headerRow: 1, ops: [{ op: 'update', row: 2, cells: { 7: 'x' } }] }), (e) => e.code === 'unknown_field' && e.status === 400);
    await assert.rejects(csv.editInPlace(Buffer.from(',\n1,2\n'), { headerRow: 1, ops: [] }), (e) => e.code === 'header_missing');
});

test('editInPlace edits in the dialect the bytes have NOW: a stored delimiter the file no longer uses never splits a row into one field', async () => {
    // linked as ';' with decimal commas, since re-saved with ',' and '.'
    const stored = { delimiter: ';', quote: '"', bom: false, eol: '\n', encoding: 'utf-8', decimal: ',' };
    const us = Buffer.from('A,B,C\n1,2.5,3\n');
    const r = await csv.editInPlace(us, { headerRow: 1, csv: stored, columns: { 1: { type: 'number' } }, ops: [{ op: 'update', row: 2, cells: { 0: 'x', 1: 7.5 } }] });
    assert.equal(r.buffer.toString('utf8'), 'A,B,C\nx,7.5,3\n', 'not "x" alone, and 7.5 in the file\'s own decimal');
    assert.equal(r.csv.delimiter, ',');
    assert.equal(r.csv.decimal, '.');
    const a = await csv.editInPlace(us, { headerRow: 1, csv: stored, ops: [{ op: 'append', cells: { 0: '4', 2: '6' } }] });
    assert.equal(a.buffer.toString('utf8'), 'A,B,C\n1,2.5,3\n4,,6\n');
    // the width the caller located its rows in is checked: a file of another shape is a conflict, not a wrong write
    await assert.rejects(csv.editInPlace(Buffer.from('A\n1\n'), { headerRow: 1, csv: stored, expectSpan: 3, ops: [{ op: 'update', row: 2, cells: { 0: 'x' } }] }),
        (e) => e.code === 'spreadsheet_conflict' && e.status === 409 && /1 columns, not the 3/.test(e.message));
    const ok = await csv.editInPlace(us, { headerRow: 1, csv: stored, expectSpan: 3, ops: [{ op: 'update', row: 2, cells: { 0: 'x' } }] });
    assert.equal(ok.buffer.toString('utf8'), 'A,B,C\nx,2.5,3\n');
    // a file wider than the reader's column cap compares at the width it was read
    const wide = await csv.editInPlace(Buffer.from('A,B,C,D\n1,2,3,4\n'), { headerRow: 1, expectSpan: 2, maxCols: 2, ops: [{ op: 'update', row: 2, cells: { 0: 'x' } }] });
    assert.equal(wide.buffer.toString('utf8'), 'A,B,C,D\nx,2,3,4\n');
});

test('editInPlace falls back to the stored dialect only where the sniff found nothing to decide on', async () => {
    // one column: no delimiter to sniff — the stored one is trusted (and harmless)
    const one = await csv.editInPlace(Buffer.from('Naam\nAcme\n'), { headerRow: 1, csv: { delimiter: ';' }, ops: [{ op: 'append', cells: { 0: 'Bee' } }] });
    assert.equal(one.buffer.toString('utf8'), 'Naam\nAcme\nBee\n');
    assert.equal(one.csv.delimiter, ';');
    assert.deepEqual(csv.sniffDelimiterDetailed('Naam\nAcme\n'), { delimiter: ',', conclusive: false });
    assert.deepEqual(csv.sniffDelimiterDetailed('A;B\n1;2\n'), { delimiter: ';', conclusive: true });
    // no decimal number in the first records: the stored decimal decides how 7.5 is spelled
    const ints = Buffer.from('A;B\n1;2\n');
    const dutch = await csv.editInPlace(ints, { headerRow: 1, csv: { delimiter: ';', decimal: ',' }, columns: { 1: { type: 'number' } }, ops: [{ op: 'append', cells: { 0: '3', 1: 7.5 } }] });
    assert.equal(dutch.buffer.toString('utf8'), 'A;B\n1;2\n3;7,5\n');
    // …but a decimal in the bytes outranks the stored one
    const withDot = await csv.editInPlace(Buffer.from('A;B\n1;2.5\n'), { headerRow: 1, csv: { delimiter: ';', decimal: ',' }, columns: { 1: { type: 'number' } }, ops: [{ op: 'append', cells: { 0: '3', 1: 7.5 } }] });
    assert.equal(withDot.buffer.toString('utf8'), 'A;B\n1;2.5\n3;7.5\n');
    // a grouped integer ('1.000' is a thousand to the reader) is no decimal evidence either way
    assert.deepEqual(csv.sniffDecimalDetailed(csv.parseRecords('A;B\n1.000;7,5\n', ';').records), { decimal: ',', conclusive: true });
    assert.deepEqual(csv.sniffDecimalDetailed(csv.parseRecords('A;B\n1.000;2\n', ';').records), { decimal: '.', conclusive: false });
});

test('formatField spells values the way the file does', () => {
    assert.equal(csv.formatField(null), '');
    assert.equal(csv.formatField(1234.5, {}, { decimal: ',' }), '1234,5');
    assert.equal(csv.formatField(1234.5, {}, { decimal: '.' }), '1234.5');
    assert.equal(csv.formatField(true), 'TRUE');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5)), { type: 'date', dateFormat: 'dd-mm-yyyy' }), '05-01-2026');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5)), { type: 'date', dateFormat: 'dd/mm/yyyy' }), '05/01/2026');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5)), { type: 'date', dateFormat: 'mm/dd/yyyy' }), '01/05/2026');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5)), { type: 'date' }), '2026-01-05');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5, 9, 30)), { type: 'datetime', dateFormat: 'dd-mm-yyyy' }), '05-01-2026 09:30');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5, 9, 30, 15)), { type: 'datetime' }), '2026-01-05 09:30:15');
    assert.equal(csv.formatField(new Date(Date.UTC(2026, 0, 5)), { type: 'datetime' }), '2026-01-05 00:00');
    assert.equal(csv.formatField('0123'), '0123');
    assert.equal(csv.quoteField('plain', ','), 'plain');
    assert.equal(csv.quoteField('a,b', ','), '"a,b"');
    assert.equal(csv.quoteField('a"b', ';'), '"a""b"');
    assert.equal(csv.quoteField(' pad', ';'), '" pad"');
});
