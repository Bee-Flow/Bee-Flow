'use strict';

/**
 * A spreadsheet's tabs against the REAL document store (PGlite behind db.js)
 * and the real sheet router; only the cells (the datatables) are a fake that
 * records which table is dropped.
 *
 * A project editor may change a sheet's content, but never point one of its
 * tabs at another table of the owner: a save that tries is refused or has
 * the table put back, so deleting the tab afterwards drops only this
 * document's own table and the owner's other spreadsheet keeps its cells.
 *
 * Run: cd server && node --test routes/studioDocuments/sheet.tabSwap.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { makeSwaps } = require('../../testUtils/swaps');
const h = require('../../testUtils/routeHarness');

const { pg, close } = usePglitePool();
const documents = require('../../stores/documentStore');
const projectRole = require('../../stores/lib/projectRole');
const { sheetTabsOf } = require('../../stores/lib/sheetDocument');
const { makeSheetRouter } = require('./sheet');

const ROLES = { p1: { alice: 'owner', bob: 'editor' } };
const { swap, restore } = makeSwaps();
const dropped = [];
let made = 0;

const router = makeSheetRouter({
    documents,
    cells: {
        async createSheetTable() { made += 1; return { id: `dt-new-${made}` }; },
        async dropSheetTable(userId, id) { dropped.push([userId, id]); return true; },
        async readSheet(_owner, tableId) { return { cells: { A1: `cells of ${tableId}` }, rows: 1, columns: 1 }; },
    },
    gate: (_req, _res, next) => next(),
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).end()),
    assistantLimiter: (_req, _res, next) => next(),
});
const api = h.serve('/api/studio-documents', router);
const as = (user, method, path, body) => api.call(method, `/api/studio-documents${path}`, { user: { id: user, organizationId: 'org1' }, body });

let shared;
let other;

before(async () => {
    await pg.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT);
        CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT, organization_id TEXT NOT NULL DEFAULT '');
        INSERT INTO users VALUES ('alice','org1'), ('bob','org1');
        INSERT INTO projects VALUES ('p1','alice','org1');`);
    await documents.initDB();
    swap(projectRole.lookup, 'roleOf', async (userId, projectId) => ROLES[projectId]?.[userId] || null);
    // Alice's sheet in the project, and a private one of hers on another table.
    shared = await documents.createDocument({ userId: 'alice', name: 'Shared', docType: 'spreadsheet', sheetTableId: 'dt-shared' });
    other = await documents.createDocument({ userId: 'alice', name: 'Salaries', docType: 'spreadsheet', sheetTableId: 'dt-private' });
    assert.strictEqual(await documents.setDocumentProject(shared.id, 'alice', 'p1'), true);
});

after(async () => {
    await api.close();
    restore();
    await close();
});

test('an editor cannot point a tab at the owner\'s other table, and deleting a tab drops only this sheet\'s own', async () => {
    const tab = sheetTabsOf(shared)[0];
    // A second tab, made the only way there is: through the tab route.
    const added = await as('bob', 'POST', `/${shared.id}/sheet/tabs`, { name: 'Two' });
    assert.strictEqual(added.status, 201, added.text);
    let current = await documents.getDocument(shared.id, 'bob');

    // The same tab id with the other table: saved, but the tab keeps its own table.
    const swapped = await documents.updateDocument(shared.id, 'bob', {
        settings: { ...current.settings, sheet: { ...current.settings.sheet, tabs: current.settings.sheet.tabs.map((t) => (t.id === tab.id ? { ...t, datatableId: 'dt-private' } : t)) } },
        expectedVersionId: current.versionId,
    });
    assert.deepStrictEqual(sheetTabsOf(swapped).map((t) => t.datatableId), ['dt-shared', 'dt-new-1']);

    // A new tab id on the other table: refused.
    current = await documents.getDocument(shared.id, 'bob');
    await assert.rejects(documents.updateDocument(shared.id, 'bob', {
        settings: { ...current.settings, sheet: { ...current.settings.sheet, tabs: [...current.settings.sheet.tabs, { id: 'evil', name: 'Salaries', datatableId: 'dt-private' }] } },
        expectedVersionId: current.versionId,
    }), (e) => e.status === 422 && e.errorClass === 'sheet_tabs_fixed');

    // Nothing reads the owner's other table through this sheet.
    const read = await as('bob', 'GET', `/${shared.id}/sheet?tab=evil`);
    assert.strictEqual(read.status, 404);
    for (const t of sheetTabsOf(await documents.getDocument(shared.id, 'bob'))) {
        const res = await as('bob', 'GET', `/${shared.id}/sheet?tab=${t.id}`);
        assert.notStrictEqual(res.body.cells.A1, 'cells of dt-private');
    }

    // Deleting the tab drops that tab's own table, never the owner's other one.
    const removed = await as('bob', 'DELETE', `/${shared.id}/sheet/tabs/${tab.id}`);
    assert.strictEqual(removed.status, 200, removed.text);
    assert.deepStrictEqual(dropped, [['alice', 'dt-shared']]);
    assert.deepStrictEqual(sheetTabsOf(await documents.getDocument(other.id, 'alice')).map((t) => t.datatableId), ['dt-private']);
});

test('the owner cannot add or remove a tab through a plain save either', async () => {
    const current = await documents.getDocument(other.id, 'alice');
    await assert.rejects(documents.updateDocument(other.id, 'alice', {
        settings: { ...current.settings, sheet: { ...current.settings.sheet, tabs: [] } },
        expectedVersionId: current.versionId,
    }), (e) => e.status === 422 && e.errorClass === 'sheet_tabs_fixed');
    const renamed = await documents.updateDocument(other.id, 'alice', {
        settings: { ...current.settings, sheet: { ...current.settings.sheet, tabs: current.settings.sheet.tabs.map((t) => ({ ...t, name: 'Blad1' })) } },
        expectedVersionId: current.versionId,
    });
    assert.deepStrictEqual(sheetTabsOf(renamed).map((t) => [t.name, t.datatableId]), [['Blad1', 'dt-private']]);
});
