/**
 * formUploadText — the text of a file a visitor attached to an automation's form.
 *
 * The behaviour under test is mostly about what does NOT happen: a submission
 * is never lost because an attachment could not be read, and a truncated
 * document never presents itself as a whole one.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const XLSX = require('@e965/xlsx');

const { readUploadText, describeClaimedUpload, MAX_TEXT_CHARS, MAX_PARSE_BYTES } = require('./formUploadText');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A storageStore stand-in that serves one buffer (or throws). */
function storeServing(buffer, { throws = null } = {}) {
    return {
        async streamFile() {
            if (throws) throw throws;
            return { stream: Readable.from([buffer]), contentLength: buffer.length };
        },
    };
}

function workbook(rows, sheetName = 'Blad1') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function claim(overrides = {}) {
    return {
        id: 'up_1',
        filename: 'jaarrekening.xlsx',
        mimeType: XLSX_MIME,
        size: 4096,
        storageKey: 'automations/u1/a1/abc',
        ...overrides,
    };
}

// ── The point of the whole module ─────────────────────────────────────────

test('a spreadsheet arrives as markdown a model can read, not as a receipt', async () => {
    const buf = workbook([
        ['Omschrijving', '2023', '2024', '2025'],
        ['Netto-omzet', 7464, 16088, 25367],
        ['Kostprijs van de omzet', 4501, 8700, 16147],
    ]);
    const out = await readUploadText(claim({ size: buf.length }), { storageStore: storeServing(buf) });

    assert.ok(out.text, 'expected text');
    assert.match(out.text, /Omschrijving/);
    assert.match(out.text, /Netto-omzet/);
    assert.match(out.text, /25367/, 'the last year has to survive');
    assert.match(out.text, /\|/, 'a spreadsheet renders as a markdown table');
    assert.strictEqual(out.textTruncated, false);
    assert.strictEqual(out.textChars, out.text.length);
    assert.strictEqual(out.textError, undefined);
});

test('every sheet of a multi-sheet workbook comes through, labelled', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Regel', '2025'], ['Omzet', 25367]]), 'WenV');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Regel', '2025'], ['Debiteuren', 2086]]), 'Balans');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const out = await readUploadText(claim({ size: buf.length }), { storageStore: storeServing(buf) });
    assert.match(out.text, /Sheet: WenV/);
    assert.match(out.text, /Sheet: Balans/);
    assert.match(out.text, /Debiteuren/);
});

test('a CSV is read the same way a workbook is', async () => {
    const buf = Buffer.from('Regel;2024;2025\nOmzet;16088;25367\n', 'utf8');
    const out = await readUploadText(
        claim({ filename: 'kolommenbalans.csv', mimeType: 'text/csv', size: buf.length }),
        { storageStore: storeServing(buf) },
    );
    assert.ok(out.text);
    assert.match(out.text, /Omzet/);
});

// ── Never lose a submission ───────────────────────────────────────────────

test('storage failing yields textError, not a throw', async () => {
    const out = await readUploadText(claim(), {
        storageStore: storeServing(null, { throws: new Error('NoSuchKey') }),
    });
    assert.ok(out.textError, 'expected a named failure');
    assert.strictEqual(out.text, undefined);
});

test('a file type that is not a document is refused by name, not parsed as mojibake', async () => {
    const out = await readUploadText(
        claim({ filename: 'meterkast.png', mimeType: 'image/png' }),
        { storageStore: storeServing(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
    );
    assert.match(out.textError, /not a document/i);
    assert.strictEqual(out.text, undefined);
});

test('a file with no stored bytes reports it instead of throwing', async () => {
    const out = await readUploadText(claim({ storageKey: null }));
    assert.ok(out.textError);
});

test('describeClaimedUpload always returns the receipt, even when extraction fails', async () => {
    const d = await describeClaimedUpload(claim(), {
        storageStore: storeServing(null, { throws: new Error('boom') }),
    });
    assert.strictEqual(d.kind, 'form_upload');
    assert.strictEqual(d.fileId, 'up_1');
    assert.strictEqual(d.filename, 'jaarrekening.xlsx');
    assert.strictEqual(d.mimeType, XLSX_MIME);
    assert.strictEqual(d.storageKey, 'automations/u1/a1/abc');
    assert.ok(d.textError, 'the failure is reported, the receipt survives');
});

test('describeClaimedUpload merges the text onto the receipt', async () => {
    const buf = workbook([['Regel', '2025'], ['Omzet', 25367]]);
    const d = await describeClaimedUpload(claim({ size: buf.length }), { storageStore: storeServing(buf) });
    assert.strictEqual(d.kind, 'form_upload');
    assert.strictEqual(d.fileId, 'up_1');
    assert.match(d.text, /Omzet/);
});

// ── Bounded twice, and truncation is announced ────────────────────────────

test('a declared size past the parse ceiling is refused before any bytes are read', async () => {
    let streamed = false;
    const store = { async streamFile() { streamed = true; throw new Error('should not get here'); } };
    const out = await readUploadText(claim({ size: MAX_PARSE_BYTES + 1 }), { storageStore: store });
    assert.strictEqual(streamed, false, 'the ceiling is checked before the read');
    assert.match(out.textError, /too large/i);
});

test('a stream that outgrows the ceiling despite its declared size is stopped', async () => {
    // A row claiming 1 KB whose bytes are 20 MB: the counted number wins.
    const big = Buffer.alloc(MAX_PARSE_BYTES + 1024, 0x41);
    const out = await readUploadText(
        claim({ filename: 'groot.csv', mimeType: 'text/csv', size: 1024 }),
        { storageStore: storeServing(big) },
    );
    assert.match(out.textError, /too large/i);
});

test('text past the carry ceiling is cut AND says so', async () => {
    const rows = [['Regel', 'Bedrag']];
    for (let i = 0; i < 6000; i++) rows.push([`Grootboekrekening ${i} met een lange omschrijving`, i * 137]);
    const buf = workbook(rows);

    const out = await readUploadText(claim({ size: buf.length }), { storageStore: storeServing(buf) });
    assert.strictEqual(out.text.length, MAX_TEXT_CHARS);
    assert.strictEqual(out.textTruncated, true, 'a model must never be told it saw the whole ledger');
    assert.ok(out.textTotalChars > MAX_TEXT_CHARS);
});

test('an empty document reports that rather than returning an empty string', async () => {
    const buf = Buffer.from('   \n  \n', 'utf8');
    const out = await readUploadText(
        claim({ filename: 'leeg.txt', mimeType: 'text/plain', size: buf.length }),
        { storageStore: storeServing(buf) },
    );
    assert.ok(out.textError);
    assert.strictEqual(out.text, undefined);
});
