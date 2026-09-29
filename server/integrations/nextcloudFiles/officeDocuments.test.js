/**
 * Tests for the nextcloud_create_spreadsheet executor's `ifExists` modes.
 *
 * The WebDAV fetch is a recording stub that serves a real spreadsheet on GET
 * and accepts MKCOL/PUT, so every case runs without network. Each PUT body is
 * parsed back with @e965/xlsx: the assertion is on the cells a spreadsheet
 * program would show, not on our own XML.
 *
 * Run: node --test --test-force-exit integrations/nextcloudFiles/officeDocuments.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const XLSX = require('@e965/xlsx');
const JSZip = require('jszip');
const officegen = require('../officegen');
const { executeOfficeDocumentTool } = require('./officeDocuments');

const ROOT = 'https://nc.example.test/remote.php/dav/files/alice';
const AUTH_ERROR = 'Reconnect Nextcloud';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';

function response({ ok, status, body = Buffer.alloc(0), contentType = 'application/octet-stream' }) {
    return {
        ok,
        status,
        headers: new Headers({ 'content-type': contentType }),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        text: async () => body.toString('utf8'),
    };
}

// `existing` = bytes served on GET (null → 404); `getStatus` overrides the GET
// status for the error cases.
function makeCtx({ existing = null, getStatus = null, contentType = XLSX_MIME } = {}) {
    const calls = [];
    const ncFetch = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, headers: opts.headers || {}, body: opts.body });
        if (method === 'GET') {
            if (getStatus) return response({ ok: getStatus >= 200 && getStatus < 300, status: getStatus });
            if (!existing) return response({ ok: false, status: 404 });
            return response({ ok: true, status: 200, body: existing, contentType });
        }
        if (method === 'MKCOL') return response({ ok: true, status: 201 });
        if (method === 'PUT') return response({ ok: true, status: existing ? 204 : 201 });
        throw new Error(`unexpected method ${method}`);
    };
    return { ctx: { ncFetch, authError: AUTH_ERROR, root: ROOT }, calls };
}

function putOf(calls) { return calls.find((c) => c.method === 'PUT'); }
function getsOf(calls) { return calls.filter((c) => c.method === 'GET'); }

function rowsOf(buffer, sheetName) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[sheetName || wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

async function ledger(format = 'xlsx', sheetName) {
    const gen = await officegen.buildSpreadsheet({ matrix: [['vendor', 'amount'], ['Acme', 10]], format, sheetName });
    return gen.buffer;
}

const run = (args, ctx) => executeOfficeDocumentTool('nextcloud_create_spreadsheet', args, ctx);

test('append: object rows land below the existing rows, mapped onto the existing header', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    const res = await run({ path: '/Ledger/invoices.xlsx', rows: [{ vendor: 'Bee', amount: 20 }], ifExists: 'append' }, ctx);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.appended, 1);
    assert.strictEqual(res.path, '/Ledger/invoices.xlsx');
    assert.strictEqual(res.contentType, XLSX_MIME);
    assert.strictEqual(getsOf(calls).length, 1, 'downloaded the existing file once');
    assert.ok(getsOf(calls)[0].url.endsWith('/Ledger/invoices.xlsx'));

    const put = putOf(calls);
    assert.ok(put, 'a PUT was made');
    assert.strictEqual(put.headers['Content-Type'], XLSX_MIME);
    assert.deepStrictEqual(rowsOf(put.body), [['vendor', 'amount'], ['Acme', 10], ['Bee', 20]]);
});

test('append: key order of the new row does not matter — columns are matched by name', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    await run({ path: '/l.xlsx', rows: [{ amount: 7, vendor: 'Swapped' }], ifExists: 'append' }, ctx);
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [['vendor', 'amount'], ['Acme', 10], ['Swapped', 7]]);
});

test('append: a row with a new key widens the header; old rows get an empty cell there', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    const res = await run({ path: '/l.xlsx', rows: [{ vendor: 'X', amount: 5, dueDate: '2026-10-01' }], ifExists: 'append' }, ctx);
    assert.strictEqual(res.appended, 1);
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [
        ['vendor', 'amount', 'dueDate'],
        ['Acme', 10, ''],
        ['X', 5, '2026-10-01'],
    ]);
});

test('append: missing keys become empty cells, extra values are coerced like the writer does', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    await run({ path: '/l.xlsx', rows: [{ vendor: 'NoAmount' }, { vendor: 'Obj', amount: { nested: true } }], ifExists: 'append' }, ctx);
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [
        ['vendor', 'amount'],
        ['Acme', 10],
        ['NoAmount', ''],
        ['Obj', '{"nested":true}'],
    ]);
});

test('append: array rows are appended verbatim', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    const res = await run({ path: '/l.xlsx', rows: [['Row', 1], ['Another', 2]], ifExists: 'append' }, ctx);
    assert.strictEqual(res.appended, 2);
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [['vendor', 'amount'], ['Acme', 10], ['Row', 1], ['Another', 2]]);
});

test('append: 404 on GET creates the file fresh — header from the row keys, appended: 0', async () => {
    const { ctx, calls } = makeCtx({ existing: null });
    const res = await run({ path: '/new/ledger.xlsx', rows: [{ vendor: 'First', amount: 1 }], ifExists: 'append' }, ctx);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.appended, 0);
    assert.strictEqual(res.created, true);
    assert.strictEqual(getsOf(calls).length, 1, 'still probed for the existing file');
    assert.ok(calls.some((c) => c.method === 'MKCOL' && c.url.endsWith('/new')), 'created the parent folder');
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [['vendor', 'amount'], ['First', 1]]);
});

test('append: an existing file that is not a spreadsheet is an error, and nothing is uploaded', async () => {
    const { ctx, calls } = makeCtx({ existing: Buffer.from('hello'), contentType: 'text/plain' });
    const res = await run({ path: '/notes.xlsx', rows: [{ a: 1 }], ifExists: 'append' }, ctx);

    assert.ok(res.error, 'returned an error');
    assert.match(res.error, /not a spreadsheet/);
    assert.match(res.error, /\/notes\.xlsx/);
    assert.strictEqual(putOf(calls), undefined, 'no PUT was made');
});

test('append: a ZIP that is not a workbook (docx) is an error too', async () => {
    const gen = await officegen.buildDocument({ content: 'hi', format: 'docx' });
    const { ctx, calls } = makeCtx({ existing: gen.buffer, contentType: gen.contentType });
    const res = await run({ path: '/doc.xlsx', rows: [{ a: 1 }], ifExists: 'append' }, ctx);
    assert.match(res.error, /not a spreadsheet/);
    assert.strictEqual(putOf(calls), undefined, 'no PUT was made');
});

test('default (no ifExists): no GET at all, PUT happens, result has no `appended` key', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    const res = await run({ path: '/l.xlsx', rows: [{ vendor: 'Only', amount: 99 }] }, ctx);

    assert.strictEqual(getsOf(calls).length, 0, 'never downloaded the existing file');
    assert.ok(putOf(calls), 'a PUT was made');
    assert.ok(!('appended' in res), 'overwrite result is unchanged');
    assert.deepStrictEqual(res, { success: true, path: '/l.xlsx', contentType: XLSX_MIME, bytes: putOf(calls).body.length, created: false, updated: true });
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [['vendor', 'amount'], ['Only', 99]], 'file holds only the new rows');
});

test('explicit ifExists:"overwrite" behaves like the default', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    const res = await run({ path: '/l.xlsx', rows: [{ vendor: 'Only', amount: 99 }], ifExists: 'overwrite' }, ctx);
    assert.strictEqual(getsOf(calls).length, 0);
    assert.ok(!('appended' in res));
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [['vendor', 'amount'], ['Only', 99]]);
});

test('unknown ifExists value is rejected before any network call', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger() });
    const res = await run({ path: '/l.xlsx', rows: [{ a: 1 }], ifExists: 'nonsense' }, ctx);
    assert.deepStrictEqual(res, { error: 'ifExists must be "overwrite" or "append"' });
    assert.strictEqual(calls.length, 0);
});

test('append: 401 on GET surfaces the auth error, no PUT', async () => {
    const { ctx, calls } = makeCtx({ getStatus: 401 });
    const res = await run({ path: '/l.xlsx', rows: [{ a: 1 }], ifExists: 'append' }, ctx);
    assert.deepStrictEqual(res, { error: AUTH_ERROR });
    assert.strictEqual(putOf(calls), undefined);
});

test('append: other GET failures are reported with their status, no PUT', async () => {
    const { ctx, calls } = makeCtx({ getStatus: 503 });
    const res = await run({ path: '/l.xlsx', rows: [{ a: 1 }], ifExists: 'append' }, ctx);
    assert.deepStrictEqual(res, { error: 'Could not read the existing spreadsheet (503)' });
    assert.strictEqual(putOf(calls), undefined);
});

test('append: .ods works the same way, including a file this tool wrote itself', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger('ods', 'Ledger'), contentType: ODS_MIME });
    const res = await run({ path: '/Ledger/invoices.ods', rows: [{ vendor: 'Bee', amount: 20 }], ifExists: 'append' }, ctx);

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.appended, 1);
    assert.strictEqual(res.contentType, ODS_MIME);
    const put = putOf(calls);
    assert.strictEqual(put.headers['Content-Type'], ODS_MIME);
    const zip = await JSZip.loadAsync(put.body);
    assert.strictEqual(await zip.file('mimetype').async('string'), ODS_MIME, 'uploaded bytes are an ODF spreadsheet');
    const wb = XLSX.read(put.body, { type: 'buffer' });
    assert.deepStrictEqual(wb.SheetNames, ['Ledger'], 'sheet name survives');
    assert.deepStrictEqual(rowsOf(put.body, 'Ledger'), [['vendor', 'amount'], ['Acme', 10], ['Bee', 20]]);
});

test('append: targets the sheet named `sheetName` and keeps the other sheets intact', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['note'], ['keep me']]), 'Notes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['vendor', 'amount'], ['Acme', 10]]), 'Ledger');
    const existing = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const { ctx, calls } = makeCtx({ existing });
    const res = await run({ path: '/book.xlsx', rows: [{ vendor: 'Bee', amount: 20 }], sheetName: 'Ledger', ifExists: 'append' }, ctx);
    assert.strictEqual(res.appended, 1);

    const out = XLSX.read(putOf(calls).body, { type: 'buffer' });
    assert.deepStrictEqual(out.SheetNames, ['Notes', 'Ledger']);
    assert.deepStrictEqual(rowsOf(putOf(calls).body, 'Notes'), [['note'], ['keep me']]);
    assert.deepStrictEqual(rowsOf(putOf(calls).body, 'Ledger'), [['vendor', 'amount'], ['Acme', 10], ['Bee', 20]]);
});

test('append: an unknown sheetName falls back to the first sheet', async () => {
    const { ctx, calls } = makeCtx({ existing: await ledger('xlsx', 'Ledger') });
    await run({ path: '/l.xlsx', rows: [{ vendor: 'Bee', amount: 20 }], sheetName: 'Nope', ifExists: 'append' }, ctx);
    const out = XLSX.read(putOf(calls).body, { type: 'buffer' });
    assert.deepStrictEqual(out.SheetNames, ['Ledger']);
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [['vendor', 'amount'], ['Acme', 10], ['Bee', 20]]);
});

test('append: an existing but EMPTY sheet is laid out like a fresh file', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Sheet1');
    const existing = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const { ctx, calls } = makeCtx({ existing });
    const res = await run({ path: '/e.xlsx', rows: [{ vendor: 'Bee', amount: 20 }], columns: ['amount', 'vendor'], ifExists: 'append' }, ctx);
    assert.strictEqual(res.appended, 1);
    assert.deepStrictEqual(rowsOf(putOf(calls).body), [['amount', 'vendor'], [20, 'Bee']]);
});
