'use strict';

/**
 * A spreadsheet attachment opens as a document (spreadsheetImportIntake.js):
 * the scope and the SSE event are told, the note names the caveats, and any
 * problem or missing access leaves the old text-only behaviour.
 *
 * Run: cd server && node --test routes/ai/directChat/spreadsheetImportIntake.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { importUploadedSpreadsheet, importNote, isSpreadsheetUpload } = require('./spreadsheetImportIntake');

const result = {
    documentId: '11111111-2222-3333-4444-555555555555', name: 'Budget',
    tabs: [{ name: 'Main', rows: 3, cols: 2 }, { name: 'Totals', rows: 1, cols: 1 }],
    truncated: [{ tab: 'Main', droppedRows: 5, droppedCols: 1 }], unsupportedFunctions: ['XLOOKUP'], skippedSheets: ['Old'],
};
const NOTHING = { base: {}, note: '' };
const att = { name: 'Budget.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

test('an allowed import marks the scope, sends document_open and returns the note', async () => {
    const events = []; const marked = [];
    const out = await importUploadedSpreadsheet({
        req: {}, send: (e, d) => events.push([e, d]), userId: 'u', buffer: Buffer.from('x'), att,
        documentScope: { markCreated: (id) => marked.push(id) },
        deps: { sheetsAllowedFor: async () => true, importWorkbook: async (a) => { assert.strictEqual(a.fileName, 'Budget.xlsx'); return result; } },
    });
    assert.strictEqual(out.base.documentId, result.documentId);
    assert.deepStrictEqual(marked, [result.documentId]);
    assert.deepStrictEqual(events, [['document_open', { documentId: result.documentId, name: 'Budget', docType: 'spreadsheet', filename: 'Budget.xlsx' }]]);
    assert.match(out.note, /imported as document 11111111-2222-3333-4444-555555555555 and opened in the side panel/);
    assert.match(out.note, /mode: "outline"[\s\S]*document_write\(\{ documentId, tab, cells, charts \}\)/);
    assert.match(out.note, /5 row\(s\) past row 2000 and 1 column\(s\) past column Z/);
    assert.match(out.note, /XLOOKUP/);
    assert.match(out.note, /Old/);
});

test('no access, or a failing import, changes nothing and does not throw', async () => {
    const events = [];
    const base = { req: {}, send: (e) => events.push(e), userId: 'u', buffer: Buffer.from('x'), att };
    assert.deepStrictEqual(await importUploadedSpreadsheet({ ...base, deps: { sheetsAllowedFor: async () => false, importWorkbook: async () => { throw new Error('must not run'); } } }), NOTHING);
    assert.deepStrictEqual(await importUploadedSpreadsheet({ ...base, deps: { sheetsAllowedFor: async () => true, importWorkbook: async () => { throw new Error('bad file'); } } }), NOTHING);
    assert.deepStrictEqual(events, []);
    assert.doesNotMatch(importNote({ ...result, truncated: [], unsupportedFunctions: [], skippedSheets: [] }), /cut|Not imported|kept as typed/);
});

test('a refusal by a storage limit reaches the model as a note, with what to do', async () => {
    const events = [];
    const refusal = Object.assign(new Error('You already have 2000 spreadsheet tabs, the most allowed is 2000. Remove tabs you no longer need from your spreadsheets, or ask your administrator to raise the limit.'), { code: 'quota_exceeded', status: 409 });
    const out = await importUploadedSpreadsheet({
        req: {}, send: (e) => events.push(e), userId: 'u', buffer: Buffer.from('x'), att,
        deps: { sheetsAllowedFor: async () => true, importWorkbook: async () => { throw refusal; } },
    });
    assert.deepStrictEqual(out.base, {});
    assert.match(out.note, /"Budget\.xlsx" could not be opened as a document, only its text is available: You already have 2000 spreadsheet tabs/);
    assert.match(out.note, /ask your administrator to raise the limit/);
    assert.deepStrictEqual(events, [], 'nothing opens in the side panel');
});

test('which attachments are spreadsheets', () => {
    for (const a of [{ name: 'a.ods' }, { name: 'A.XLSX' }, { name: 'x', type: 'text/csv' }, { name: 'x', type: 'application/vnd.oasis.opendocument.spreadsheet' }]) assert.ok(isSpreadsheetUpload(a), a.name);
    assert.ok(!isSpreadsheetUpload({ name: 'a.pdf', type: 'application/pdf' }));
});
