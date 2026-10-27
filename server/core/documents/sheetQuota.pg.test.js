'use strict';

/**
 * The storage envelope a workspace that processes many spreadsheets runs
 * into, END TO END against a real Postgres (PGlite behind db.js,
 * testUtils/pglitePool.js): real stores, the real migration planner and DDL,
 * the real datatable runtime and the real retention job.
 *
 * Every tab of a spreadsheet (started in Documents, or a workbook opened in
 * chat) keeps its cells in a personal datatable. Those used to count against
 * the cap of tables people make, so a handful of multi-tab workbooks filled
 * it and both new spreadsheets and new tables were refused. Pinned here:
 *   - spreadsheets and chat imports count on their own cap, never on the table cap;
 *   - the table cap still refuses, with a sentence that says what to do;
 *   - the spreadsheet-tab cap refuses too, and 0 lifts it;
 *   - the retention job drops a sheet table no document points at, and never
 *     a table people made, an archived spreadsheet's, a fresh one, or one it
 *     cannot tell about.
 *
 * Run: cd server && node --test core/documents/sheetQuota.pg.test.js
 */

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { close } = usePglitePool();
const db = require('../../db');
const datatableStore = require('../../stores/datatableStore');
const documents = require('../../stores/documentStore');
const { makeSheetCells } = require('./sheetCells');
const { makeSheetImport } = require('./sheetImport');
const { buildXlsxWorkbook } = require('./office/xlsxWorkbook');
const { createStudioDatatable } = require('../dataEngine/createStudioDatatable');

const principal = (/** @type {string} */ userId) => ({
    userId, orgId: null, organizationId: null, orgRole: null, groupIds: [], orgIds: new Set(), identityError: null,
});
const sheets = makeSheetCells({ principalFor: async (userId) => principal(userId) });
const importer = makeSheetImport({ cells: sheets });

const ENV = ['DATATABLE_MAX_TABLES_PER_SCOPE', 'DATATABLE_MAX_SHEET_TABLES_PER_SCOPE', 'DATATABLE_MAX_MB_PER_SCOPE'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
    for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
});

/** A spreadsheet the way Documents → New → Spreadsheet makes one (routes/studioDocuments/sheet.js startSheet). */
async function newSpreadsheet(/** @type {string} */ userId, /** @type {string} */ name) {
    const table = await sheets.createSheetTable({ ownerUserId: userId, name });
    return documents.createDocument({ userId, name, docType: 'spreadsheet', kind: 'document', visibility: 'private', folderId: null, sheetTableId: table.id });
}

const userTable = (/** @type {string} */ userId, /** @type {string} */ name) => createStudioDatatable({
    ownerUserId: userId, principal: principal(userId), name, fields: [{ key: 'title', name: 'Title', type: 'text' }],
});

const usage = (/** @type {string} */ userId) => datatableStore.scopeUsage(datatableStore.userScope(userId));
const exists = async (/** @type {string} */ userId, /** @type {string} */ id) => !!(await datatableStore.getDatatable(id, datatableStore.userScope(userId)));
const backdate = (/** @type {string} */ userId) => db.run(
    `UPDATE datatables SET created_at = NOW() - INTERVAL '2 days' WHERE scope_kind = 'user' AND scope_id = $1`, [userId]);

before(async () => {
    // PGlite is one session: each store's schema init in turn.
    await require('../../stores/userStore').initDB().catch(() => undefined);
    await datatableStore.initDB();
    await documents.initDB();
});

after(close);

test('many spreadsheets and chat workbook imports do not use up the table cap', async () => {
    process.env.DATATABLE_MAX_TABLES_PER_SCOPE = '3';
    for (let i = 1; i <= 4; i++) await newSpreadsheet('alice', `Budget ${i}`);
    const workbook = await buildXlsxWorkbook([
        { name: 'Orders', matrix: [['Id', 'Total'], ['1', '10']] },
        { name: 'Customers', matrix: [['Name'], ['Acme']] },
        { name: 'Notes', matrix: [['x']] },
    ]);
    // Several Excel files processed in chat: each a spreadsheet document with one table per tab.
    for (let run = 1; run <= 2; run++) {
        const out = await importer.importWorkbook({ userId: 'alice', buffer: workbook, fileName: `Export ${run}.xlsx` });
        assert.strictEqual(out.tabs.length, 3);
    }
    assert.deepStrictEqual(
        { tables: (await usage('alice')).tables, sheetTables: (await usage('alice')).sheetTables },
        { tables: 0, sheetTables: 10 },
        'ten spreadsheet tabs, none of them counted as a table',
    );

    // The tables alice makes herself still have the whole cap.
    for (const name of ['Leads', 'Orders', 'Stock']) assert.strictEqual((await userTable('alice', name)).ok, true, name);
    // And spreadsheets keep working once that cap is reached.
    await newSpreadsheet('alice', 'After the cap');
});

test('the real table cap still refuses, and says what to do', async () => {
    process.env.DATATABLE_MAX_TABLES_PER_SCOPE = '3';
    const refused = await userTable('alice', 'One too many');
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.code, 'quota');
    assert.strictEqual(refused.error, 'You already have 3 personal datatables, the most allowed is 3. Delete tables you no longer need under Studio → Datatables, or ask your administrator to raise the limit.');

    process.env.DATATABLE_MAX_TABLES_PER_SCOPE = '0';
    assert.strictEqual((await userTable('alice', 'Unlimited')).ok, true, '0 = unlimited');
});

test('the spreadsheet-tab cap refuses a new spreadsheet with its own sentence, and 0 lifts it', async () => {
    const { sheetTables } = await usage('alice');
    process.env.DATATABLE_MAX_SHEET_TABLES_PER_SCOPE = String(sheetTables);
    await assert.rejects(sheets.createSheetTable({ ownerUserId: 'alice', name: 'Full' }), (e) => {
        assert.strictEqual(/** @type {any} */ (e).status, 409);
        assert.strictEqual(/** @type {any} */ (e).code, 'quota_exceeded');
        assert.strictEqual(/** @type {Error} */ (e).message, `You already have ${sheetTables} spreadsheet tabs, the most allowed is ${sheetTables}. Remove tabs you no longer need from your spreadsheets, or ask your administrator to raise the limit.`);
        return true;
    });
    // A chat import refused half-way gives back the tabs it had made.
    await assert.rejects(importer.importWorkbook({ userId: 'alice', buffer: Buffer.from('a,b\n1,2\n'), fileName: 'more.csv', mimeType: 'text/csv' }), /spreadsheet tabs/);
    assert.strictEqual((await usage('alice')).sheetTables, sheetTables);

    process.env.DATATABLE_MAX_SHEET_TABLES_PER_SCOPE = '0';
    await newSpreadsheet('alice', 'No cap');
    assert.strictEqual((await usage('alice')).sheetTables, sheetTables + 1);
});

test('storage bounds spreadsheet tabs, measured live rather than from the last sweep', async () => {
    const first = await newSpreadsheet('frank', 'Big');
    const [tableId] = first.settings.sheet.tabs.map((/** @type {any} */ t) => t.datatableId);
    // About 2 MB of cells nothing can compress.
    const cells = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`A${i + 1}`, require('node:crypto').randomBytes(5000).toString('hex')]));
    await sheets.writeCells('frank', tableId, cells);
    assert.strictEqual((await usage('frank')).bytes, 0, 'the stored size is still the stale one');

    process.env.DATATABLE_MAX_MB_PER_SCOPE = '1';
    await assert.rejects(sheets.createSheetTable({ ownerUserId: 'frank', name: 'One more' }),
        (e) => /** @type {any} */ (e).code === 'quota_exceeded' && /storage limit of 1 MB\. Delete rows or tables/.test(/** @type {Error} */ (e).message));
    process.env.DATATABLE_MAX_MB_PER_SCOPE = '0';
    await sheets.createSheetTable({ ownerUserId: 'frank', name: 'Unlimited' });
});

test('the retention job drops a sheet table no document points at, and nothing else', async () => {
    const job = require('../../jobs/datatableRetention');

    // A create that failed between the table and its document.
    const orphan = await sheets.createSheetTable({ ownerUserId: 'carol', name: 'Lost' });
    // An open spreadsheet, and a deleted (archived) one: a restore brings it back.
    const open = await newSpreadsheet('carol', 'Open');
    const archived = await newSpreadsheet('carol', 'Archived');
    assert.strictEqual(await documents.deleteDocument(archived.id, { userId: 'carol' }), true);
    // A spreadsheet from before the table → document link existed: named only in its settings.
    const legacy = await newSpreadsheet('carol', 'Legacy');
    await db.run('DELETE FROM studio_sheet_documents WHERE document_id = $1', [legacy.id]);
    // A table carol made herself.
    const own = await userTable('carol', 'Contacts');
    assert.strictEqual(own.ok, true);
    const tabIds = (/** @type {any} */ doc) => doc.settings.sheet.tabs.map((/** @type {any} */ t) => t.datatableId);
    const [openTable] = tabIds(open);
    const [archivedTable] = tabIds(archived);
    const [legacyTable] = tabIds(legacy);
    await backdate('carol');
    // Made just now: its document may still be on its way.
    const fresh = await sheets.createSheetTable({ ownerUserId: 'carol', name: 'Just made' });
    const before = (await usage('carol')).sheetTables;

    const pass = await job.datatableRetentionPass();
    assert.strictEqual(pass.orphanSheetTables, 1);
    assert.strictEqual(await exists('carol', orphan.id), false, 'the orphan is gone');
    for (const [label, id] of [['open', openTable], ['archived', archivedTable], ['legacy', legacyTable], ['fresh', fresh.id], ['own table', own.ok ? own.table.id : '']]) {
        assert.strictEqual(await exists('carol', id), true, `${label} is kept`);
    }
    assert.strictEqual((await usage('carol')).sheetTables, before - 1, 'the owner gets the tab back');
    assert.strictEqual((await job.datatableRetentionPass()).orphanSheetTables, 0, 'a second pass finds nothing');
});

test('an owner whose spreadsheets cannot all be read is left alone', async () => {
    const job = require('../../jobs/datatableRetention');
    const orphan = await sheets.createSheetTable({ ownerUserId: 'dave', name: 'Lost' });
    // A spreadsheet that is neither linked nor plaintext (its settings sealed):
    // which tables it names cannot be told, so none of dave's are touched.
    const sealed = await newSpreadsheet('dave', 'Sealed');
    await db.run('DELETE FROM studio_sheet_documents WHERE document_id = $1', [sealed.id]);
    await db.run(`UPDATE studio_documents SET settings = '{"sealed":"opaque"}'::jsonb WHERE id = $1`, [sealed.id]);
    await backdate('dave');

    await job.datatableRetentionPass();
    assert.strictEqual(await exists('dave', orphan.id), true);
});

test('DATATABLE_RETENTION_DISABLED stops the cleanup too', async () => {
    const job = require('../../jobs/datatableRetention');
    const orphan = await sheets.createSheetTable({ ownerUserId: 'erin', name: 'Lost' });
    await backdate('erin');
    const prev = process.env.DATATABLE_RETENTION_DISABLED;
    process.env.DATATABLE_RETENTION_DISABLED = '1';
    try {
        assert.strictEqual((await job.datatableRetentionPass()).disabled, true);
        assert.strictEqual(await exists('erin', orphan.id), true);
    } finally {
        if (prev === undefined) delete process.env.DATATABLE_RETENTION_DISABLED;
        else process.env.DATATABLE_RETENTION_DISABLED = prev;
    }
});
