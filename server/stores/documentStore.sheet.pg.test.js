'use strict';

/**
 * Spreadsheet documents in the document store, against a real Postgres (PGlite
 * behind db.js): a sheet is only ever created with the table the sheet route
 * made (`sheetTableId`), never from `settings`; no save can point it at
 * another table or turn it into another type; and it is not a designed
 * document, nor something a routine's document picker offers to fill.
 *
 * Run: cd server && node --test stores/documentStore.sheet.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const documents = require('./documentStore');

let sheet;

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        INSERT INTO users VALUES ('alice','org1');
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');`);
    await documents.initDB();
    sheet = await documents.createDocument({ userId: 'alice', name: 'Budget', docType: 'spreadsheet', sheetTableId: 'dt-1', bodyHtml: '<p>ignored</p>' });
    await documents.createDocument({ userId: 'alice', name: 'Letter', docType: 'letter' });
});

after(close);

test('a spreadsheet keeps its table in settings and nothing in the body', async () => {
    assert.strictEqual(sheet.docType, 'spreadsheet');
    assert.deepStrictEqual(sheet.settings.sheet, { datatableId: 'dt-1' });
    assert.strictEqual(sheet.bodyHtml, '');
});

test('a spreadsheet is never made from settings alone, nor as a template', async () => {
    await assert.rejects(documents.createDocument({ userId: 'alice', name: 'X', docType: 'spreadsheet', settings: { sheet: { datatableId: 'someone-elses' } } }),
        (e) => e.status === 422 && e.errorClass === 'sheet_needs_table');
    await assert.rejects(documents.createDocument({ userId: 'alice', name: 'X', docType: 'spreadsheet', sheetTableId: 'dt-2', kind: 'template' }),
        (e) => /not a template/.test(e.message));
    // Another type does not carry a sheet key, whatever settings said.
    const letter = await documents.createDocument({ userId: 'alice', name: 'Y', docType: 'letter', settings: { sheet: { datatableId: 'dt-x' } } });
    assert.strictEqual(letter.settings.sheet, undefined);
});

test('no save re-points the table or changes the type', async () => {
    const renamed = await documents.updateDocument(sheet.id, 'alice', {
        name: 'Budget 2026', settings: { sheet: { datatableId: 'someone-elses' } }, expectedVersionId: sheet.versionId,
    });
    assert.strictEqual(renamed.name, 'Budget 2026');
    assert.deepStrictEqual(renamed.settings.sheet, { datatableId: 'dt-1' });
    await assert.rejects(documents.updateDocument(sheet.id, 'alice', { docType: 'letter', expectedVersionId: renamed.versionId }),
        (e) => e.status === 422 && e.errorClass === 'document_type_fixed');
    const letter = (await documents.listDocumentsPage('alice', { kind: 'document', docType: 'letter' })).documents[0];
    await assert.rejects(documents.updateDocument(letter.id, 'alice', { docType: 'spreadsheet', expectedVersionId: letter.versionId }),
        (e) => e.status === 422 && e.errorClass === 'document_type_fixed');
});

test('a spreadsheet is its own type in the library, not a designed or fillable document', async () => {
    const names = async (o) => (await documents.listDocumentsPage('alice', o)).documents.map((d) => d.name).sort();
    assert.deepStrictEqual(await names({ kind: 'document', docType: 'spreadsheet' }), ['Budget 2026']);
    assert.deepStrictEqual(await names({ kind: 'document', docType: 'designed' }), ['Letter', 'Y']);
    assert.ok(!(await names({ onlyFillable: true })).includes('Budget 2026'));
});
