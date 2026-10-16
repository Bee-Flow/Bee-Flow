/**
 * create_spreadsheet — the chat's .xlsx tool. Pinned here: a real workbook
 * comes out (parsed back: sheets, numbers as numbers, formulas), it lands
 * under the caller's own storage prefix, the chat card and link, the
 * Nextcloud destination with its fallback, and the refusals.
 *
 * DB-free: storage and Nextcloud are stubbed; the builder is real.
 *
 * Run: node --test integrations/spreadsheetTools.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');

const { installResolveStub } = require('../testUtils/stubRequire');

const uploads = [];
const storage = {
    available: true,
    isAvailable: () => storage.available,
    buildKey: (userId, category, filename) => `users/${userId}/${category}/${filename}`,
    buildProxyUrl: (key) => `/api/storage/file/${key.split('/').map(encodeURIComponent).join('/')}`,
    uploadFile: async (key, buffer, contentType) => { uploads.push({ key, buffer, contentType }); },
};

const ncPuts = [];
const nc = { connected: true, status: 201, throwOnPut: false };
const ncClient = {
    resolveAuth: async () => {
        if (!nc.connected) throw new Error('Nextcloud not connected.');
        return {
            mode: 'basic', baseUrl: 'https://cloud.example', uid: 'tom', authError: 'auth',
            fetch: async (url, opts = {}) => {
                if (opts.method === 'PUT' && nc.throwOnPut) throw new Error('getaddrinfo ENOTFOUND cloud.example');
                if (opts.method === 'PUT') ncPuts.push({ url, size: opts.body.length });
                return { ok: true, status: opts.method === 'PUT' ? nc.status : 201, headers: { get: (h) => (h === 'oc-fileid' ? '00000482ocabc' : null) }, text: async () => '' };
            },
        };
    },
    webdavRoot: (baseUrl, uid) => `${baseUrl}/remote.php/dav/files/${uid}`,
    REQUEST_TIMEOUT_MS: 30_000,
};

installResolveStub({
    '../stores/storageStore': storage,
    './nextcloudClient': ncClient,
    '../nextcloudClient': ncClient,
});

const { SPREADSHEET_TOOLS, isSpreadsheetTool, safeSpreadsheetFileName, buildSpreadsheetFile } = require('./spreadsheetTools');
// The builder is pure; storage and Nextcloud are the shared delivery's (officeFileDelivery.js).
const { buildAndDeliver, destinationPath } = require('./officeFileDelivery');
const executeSpreadsheetTool = (args, ctx) => buildAndDeliver('create_spreadsheet', args, ctx);
const nextcloudXlsxPath = (p, a) => destinationPath(p, 'xlsx', safeSpreadsheetFileName(a.fileName || a.title));

async function readBook(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const wb = await zip.file('xl/workbook.xml').async('string');
    const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    const sheets = [];
    for (let i = 1; zip.file(`xl/worksheets/sheet${i}.xml`); i++) sheets.push(await zip.file(`xl/worksheets/sheet${i}.xml`).async('string'));
    return { names, sheets };
}

const TWO_SHEETS = {
    title: 'Budget 2026',
    sheets: [
        { name: 'Q1', rows: [{ Post: 'Huur', Bedrag: 1200 }, { Post: 'Licenties', Bedrag: 349.5 }] },
        { name: 'Totaal', columns: ['Label', 'Waarde'], rows: [['Som', { formula: '=SUM(Q1!B2:B3)' }], ['Tekst', 'a < b & c'], ['Tekst met =', '=SUM(1,1)'], ['Plus', '+1+1'], ['Apenstaart', '@SUM(A1)'], ['Tab', '\t=1+1']] },
    ],
};

test('the tool description tells the model how to request a formula', () => {
    assert.match(SPREADSHEET_TOOLS[0].function.description, /\{"formula": "=SUM\(B2:B10\)"\}/);
});

test('the tool schema: title + sheets required, fileName and Nextcloud optional', () => {
    const fn = SPREADSHEET_TOOLS[0].function;
    assert.strictEqual(fn.name, 'create_spreadsheet');
    assert.deepStrictEqual(fn.parameters.required, ['title', 'sheets']);
    for (const k of ['title', 'sheets', 'fileName', 'nextcloudPath']) assert.ok(fn.parameters.properties[k], k);
    assert.strictEqual(isSpreadsheetTool('create_spreadsheet'), true);
    assert.strictEqual(isSpreadsheetTool('nextcloud_create_spreadsheet'), false);
});

test('a real two-sheet .xlsx, numbers as numbers, formula as formula, under the user prefix', async () => {
    uploads.length = 0;
    const res = await executeSpreadsheetTool(TWO_SHEETS, { userId: 'u1' });
    assert.strictEqual(res.success, true, JSON.stringify(res));
    assert.strictEqual(res.filename, 'Budget-2026.xlsx');
    assert.strictEqual(res.sheets, 2);
    assert.match(res.downloadUrl, /^\/api\/storage\/file\/users\/u1\/documents\/\d+_[0-9a-f]{6}_Budget-2026\.xlsx$/);
    assert.strictEqual(uploads.length, 1);
    assert.ok(uploads[0].key.startsWith('users/u1/documents/'));
    assert.strictEqual(uploads[0].buffer.subarray(0, 2).toString('latin1'), 'PK');

    const { names, sheets } = await readBook(uploads[0].buffer);
    assert.deepStrictEqual(names, ['Q1', 'Totaal']);
    assert.match(sheets[0], /<c r="A1" t="inlineStr"><is><t[^>]*>Post<\/t>/);
    assert.match(sheets[0], /<c r="B2"><v>1200<\/v><\/c>/);
    assert.match(sheets[0], /<c r="B3"><v>349.5<\/v><\/c>/);
    assert.match(sheets[1], /<c r="B2"><f>SUM\(Q1!B2:B3\)<\/f><\/c>/);
    assert.match(sheets[1], /a &lt; b &amp; c/);
    // Text that merely starts like a formula stays text.
    assert.match(sheets[1], /<c r="B4" t="inlineStr"><is><t[^>]*>=SUM\(1,1\)<\/t>/);
    assert.match(sheets[1], /<c r="B5" t="inlineStr"><is><t[^>]*>\+1\+1<\/t>/);
    assert.match(sheets[1], /<c r="B6" t="inlineStr"><is><t[^>]*>@SUM\(A1\)<\/t>/);
    assert.match(sheets[1], /<c r="B7" t="inlineStr"><is><t[^>]*>\t=1\+1<\/t>/);
    assert.strictEqual((sheets[1].match(/<f>/g) || []).length, 1, 'one formula, the marked one');

    assert.deepStrictEqual(res.file, {
        kind: 'spreadsheet', name: 'Budget-2026.xlsx', mimeType: uploads[0].contentType, size: res.size, url: res.downloadUrl, source: 'create_spreadsheet',
    });
    assert.ok(res.message.includes(`[Budget-2026.xlsx](${res.downloadUrl})`));
});

test('plain decimal strings become numbers; a leading zero, a header or a word stays text', async () => {
    const built = await buildSpreadsheetFile({ title: 't', sheets: [{ rows: [{ '2026': '1200', Rate: '-3.5', Postcode: '0612', Code: '1e5' }] }] });
    const [sheet] = (await readBook(built.buffer)).sheets;
    assert.match(sheet, /<c r="A1" t="inlineStr"><is><t[^>]*>2026<\/t>/);
    assert.match(sheet, /<c r="A2"><v>1200<\/v><\/c>/);
    assert.match(sheet, /<c r="B2"><v>-3.5<\/v><\/c>/);
    assert.match(sheet, /<c r="C2" t="inlineStr"><is><t[^>]*>0612<\/t>/);
    assert.match(sheet, /<c r="D2" t="inlineStr"><is><t[^>]*>1e5<\/t>/);
});

test('sheet names are sanitised and made unique', async () => {
    const built = await buildSpreadsheetFile({ title: 't', sheets: [{ name: 'A/B', rows: [[1]] }, { name: 'a b', rows: [[2]] }, { rows: [[3]] }] });
    assert.deepStrictEqual((await readBook(built.buffer)).names, ['A B', 'a b_2', 'Sheet3']);
});

test('validation errors the model can fix', async () => {
    const ctx = { userId: 'u1' };
    for (const args of [
        { title: 't' },
        { title: 't', sheets: [] },
        { title: 't', sheets: [{ name: 'x', rows: [] }] },
        { title: 't', sheets: [{ rows: ['text'] }] },
        { title: 't', sheets: Array.from({ length: 21 }, () => ({ rows: [[1]] })) },
        { title: 't', sheets: [{ rows: Array.from({ length: 501 }, () => Array(101).fill(1)) }] },
    ]) {
        const res = await executeSpreadsheetTool(args, ctx);
        assert.ok(res.error, JSON.stringify(args).slice(0, 80));
        assert.ok(!res.success);
    }
    assert.ok((await executeSpreadsheetTool(TWO_SHEETS, {})).error, 'no user');
});

test('file names are ASCII-safe and end in .xlsx', () => {
    assert.strictEqual(safeSpreadsheetFileName('Café résumé.xlsx'), 'Cafe-resume.xlsx');
    assert.strictEqual(safeSpreadsheetFileName('../../etc/passwd'), 'etc-passwd.xlsx');
    assert.strictEqual(safeSpreadsheetFileName('???'), 'spreadsheet.xlsx');
    assert.ok(safeSpreadsheetFileName('x'.repeat(300)).length <= 85);
});

test('nextcloudPath: a folder gets the file name, an .xlsx path is the file, non-strings are ignored', () => {
    assert.strictEqual(nextcloudXlsxPath('/Documents/', { title: 'Budget 2026' }), '/Documents/Budget-2026.xlsx');
    assert.strictEqual(nextcloudXlsxPath('/Documents', { fileName: 'x.xlsx', title: 'y' }), '/Documents/x.xlsx');
    assert.strictEqual(nextcloudXlsxPath('/D/mine.XLSX', {}), '/D/mine.XLSX');
    assert.strictEqual(nextcloudXlsxPath(true, { title: 'a' }), '');
    assert.strictEqual(nextcloudXlsxPath('  ', { title: 'a' }), '');
});

test('with nextcloudPath the workbook goes to Nextcloud, not storage', async () => {
    uploads.length = 0; ncPuts.length = 0;
    nc.connected = true; nc.throwOnPut = false; nc.status = 201;
    const res = await executeSpreadsheetTool(TWO_SHEETS, { userId: 'u1', nextcloudPath: '/Documents/budget.xlsx' });
    assert.strictEqual(uploads.length, 0);
    assert.strictEqual(ncPuts.length, 1);
    assert.match(ncPuts[0].url, /\/remote\.php\/dav\/files\/tom\/Documents\/budget\.xlsx$/);
    assert.strictEqual(res.filename, 'budget.xlsx');
    assert.strictEqual(res.file.kind, 'spreadsheet');
    assert.strictEqual(res.webUrl, 'https://cloud.example/f/482');
});

test('a Nextcloud that fails, or a refused scope, still gives a storage link', async () => {
    uploads.length = 0;
    nc.connected = true; nc.throwOnPut = true;
    const down = await executeSpreadsheetTool(TWO_SHEETS, { userId: 'u1', nextcloudPath: '/D/b.xlsx' });
    assert.strictEqual(down.success, true);
    assert.ok(down.nextcloud.error);
    assert.match(down.message, /could NOT be saved to Nextcloud/);
    nc.throwOnPut = false;
    const denied = await executeSpreadsheetTool(TWO_SHEETS, { userId: 'u1', nextcloudPath: '/D/b.xlsx', nextcloudError: 'not allowed' });
    assert.strictEqual(denied.nextcloud.error, 'not allowed');
    assert.strictEqual(uploads.length, 2);
});

test('storage unavailable is an error, with and without a Nextcloud failure', async () => {
    storage.available = false;
    try {
        const a = await executeSpreadsheetTool(TWO_SHEETS, { userId: 'u1' });
        assert.match(a.error, /File storage is not available/);
        const b = await executeSpreadsheetTool(TWO_SHEETS, { userId: 'u1', nextcloudError: 'denied' });
        assert.match(b.error, /denied/);
    } finally {
        storage.available = true;
    }
});
