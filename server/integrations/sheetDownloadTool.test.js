// @typecheck
'use strict';

/**
 * document_download (integrations/sheetDownloadTool.js, dispatched by
 * documentBuilderTools): a spreadsheet becomes an .xlsx / .csv in the caller's
 * storage prefix, with a download card. Storage and cells are stubbed.
 *
 * Run: cd server && node --test integrations/sheetDownloadTool.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { downloadSheetDocument } = require('./sheetDownloadTool');
const { evaluateSheet } = require('../shared/expr/sheet.mjs');

const doc = {
    id: 's1', userId: 'owner', name: 'Budget', docType: 'spreadsheet',
    settings: { sheet: { tabs: [{ id: 't1', name: 'Main', datatableId: 'dt1' }, { id: 't2', name: 'Totals', datatableId: 'dt2' }] } },
};
const data = { dt1: { A1: 'Rent', B1: '1200', B2: '=B1*2' }, dt2: { A1: '=3*4' } };
const cells = { async readSheet(owner, table) { assert.strictEqual(owner, 'owner'); return { cells: data[table], rows: 2 }; } };
const uploads = [];
const storage = {
    isAvailable: () => true,
    buildKey: (userId, folder, name) => `users/${userId}/${folder}/${name}`,
    async uploadFile(key, buffer, type) { uploads.push({ key, buffer, type }); },
    buildProxyUrl: (key) => `/api/storage/file/${key}`,
};
const deps = { cells, storage, evaluate: evaluateSheet };
const run = (d, args, ctx = { userId: 'viewer1' }) => downloadSheetDocument(d, args, ctx, deps);

test('xlsx by default: every tab, stored under the CALLER prefix, with a download card', async () => {
    uploads.length = 0;
    const out = await run(doc, { documentId: 's1' });
    assert.strictEqual(out.success, true);
    assert.match(out.filename, /^Budget\.xlsx$/);
    assert.match(uploads[0].key, /^users\/viewer1\/documents\/\d+_[0-9a-f]{6}_Budget\.xlsx$/);
    assert.strictEqual(out.downloadUrl, `/api/storage/file/${uploads[0].key}`);
    assert.deepStrictEqual(out.file, {
        kind: 'spreadsheet', name: 'Budget.xlsx', mimeType: uploads[0].type, size: out.size,
        url: out.downloadUrl, documentId: 's1', source: 'document_download',
    });
    assert.strictEqual(out.documentId, undefined, 'no top-level documentId: that would reload the open editor');
    assert.ok(out.message.includes(`[Budget.xlsx](${out.downloadUrl})`));
    const zip = await JSZip.loadAsync(uploads[0].buffer);
    assert.match(await zip.file('xl/workbook.xml').async('string'), /name="Main"[\s\S]*name="Totals"/);
    assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<f>B1\*2<\/f>/);
});

test('csv: the computed values of one tab, chosen by name', async () => {
    uploads.length = 0;
    const out = await run(doc, { documentId: 's1', format: 'csv', tab: 'totals' });
    assert.strictEqual(out.filename, 'Budget.csv');
    assert.strictEqual(uploads[0].buffer.toString('utf8').replace(/^﻿/, ''), '12\r\n');
    const first = await run(doc, { documentId: 's1', format: 'csv' });
    assert.strictEqual(first.file.mimeType, 'text/csv; charset=utf-8');
    assert.match((await run(doc, { documentId: 's1', format: 'csv', tab: 'Nope' })).error, /no tab "Nope"/);
});

test('only spreadsheets, and a storage that is off is explained', async () => {
    assert.match((await run({ ...doc, docType: 'page' }, {})).error, /for spreadsheets/);
    const off = await downloadSheetDocument(doc, {}, { userId: 'u' }, { ...deps, storage: { ...storage, isAvailable: () => false } });
    assert.match(off.error, /storage is not available/);
});
