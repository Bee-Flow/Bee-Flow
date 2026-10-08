'use strict';

/**
 * A spreadsheet's cells in a datatable, END TO END against a real Postgres
 * (PGlite behind db.js, testUtils/pglitePool.js): the managed `document_sheet`
 * table is provisioned through the real store, migration planner and DDL, and
 * every read and write goes through the real datatable runtime and query
 * compiler. Only the principal is handed in (its resolver reads the users
 * store, which has its own suite).
 *
 * Run: cd server && node --test core/documents/sheetCells.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { close } = usePglitePool();
const datatableStore = require('../../stores/datatableStore');
const { makeSheetCells, LIMITS } = require('./sheetCells');

const principal = (userId) => ({
    userId, orgId: null, organizationId: null, orgRole: null, groupIds: [], orgIds: new Set(), identityError: null,
});
const sheets = makeSheetCells({ principalFor: async (userId) => principal(userId) });

let table;

before(async () => {
    // The users store starts its own schema init when it loads (the datatable
    // access module requires it). PGlite is one session: let that finish
    // before this file opens its first transaction.
    await require('../../stores/userStore').initDB().catch(() => undefined);
    await datatableStore.initDB?.();
    table = await sheets.createSheetTable({ ownerUserId: 'alice', name: 'Budget 2026' });
});

after(close);

test('a new sheet is a personal managed table with a row number and columns A to Z', async () => {
    const row = await datatableStore.getDatatable(table.id, datatableStore.userScope('alice'));
    assert.ok(row, 'the table exists in alice\'s own scope');
    assert.strictEqual(row.managedKind, 'document_sheet');
    assert.strictEqual(row.name, 'Spreadsheet: Budget 2026');
    const meta = await datatableStore.getTableMeta(datatableStore.userScope('alice'), table.id);
    const keys = meta.fields.map((f) => f.key);
    assert.deepStrictEqual(keys.slice(0, 3), ['row_no', 'a', 'b']);
    assert.strictEqual(keys.length, 1 + LIMITS.COLUMNS);
    assert.deepStrictEqual(await sheets.readSheet('alice', table.id), { cells: {}, rows: 0, columns: 26 });
});

test('cells are written and read back as typed, formulas included', async () => {
    const saved = await sheets.writeCells('alice', table.id, { A1: 'Rent', B1: '1200', A2: 'Food', B2: '450', B3: '=SUM(B1:B2)' });
    assert.deepStrictEqual(saved.cells, { A1: 'Rent', B1: '1200', A2: 'Food', B2: '450', B3: '=SUM(B1:B2)' });
    const sheet = await sheets.readSheet('alice', table.id);
    assert.deepStrictEqual(sheet.cells, { A1: 'Rent', B1: '1200', A2: 'Food', B2: '450', B3: '=SUM(B1:B2)' });
    assert.strictEqual(sheet.rows, 3);
});

test('changing one cell of a row keeps the others; clearing removes just that cell', async () => {
    await sheets.writeCells('alice', table.id, { B1: '1250' });
    await sheets.writeCells('alice', table.id, { A2: '' });
    const { cells } = await sheets.readSheet('alice', table.id);
    assert.strictEqual(cells.A1, 'Rent');
    assert.strictEqual(cells.B1, '1250');
    assert.strictEqual(cells.A2, undefined);
    assert.strictEqual(cells.B2, '450');
    // Clearing a cell of a row that was never written writes nothing.
    await sheets.writeCells('alice', table.id, { Z900: '' });
    assert.strictEqual((await sheets.readSheet('alice', table.id)).rows, 3);
});

test('a write the other writer got to first is put on top of theirs, not lost', async () => {
    // Two writes to the same row at once: both cells survive.
    await Promise.all([
        sheets.writeCells('alice', table.id, { C1: 'x' }),
        sheets.writeCells('alice', table.id, { D1: 'y' }),
    ]);
    const { cells } = await sheets.readSheet('alice', table.id);
    assert.strictEqual(cells.C1, 'x');
    assert.strictEqual(cells.D1, 'y');
    assert.strictEqual(cells.B1, '1250');
});

test('a paste over many rows lands in one write', async () => {
    const paste = {};
    for (let r = 10; r < 60; r++) { paste[`A${r}`] = String(r); paste[`B${r}`] = `=A${r}*2`; }
    await sheets.writeCells('alice', table.id, paste);
    const { cells, rows } = await sheets.readSheet('alice', table.id);
    assert.strictEqual(cells.A59, '59');
    assert.strictEqual(cells.B10, '=A10*2');
    assert.strictEqual(rows, 59);
});

test('a copy goes into another table and owner, cell for cell', async () => {
    const copy = await sheets.createSheetTable({ ownerUserId: 'bob', name: 'Budget copy' });
    await sheets.copyCells('alice', table.id, copy.id, 'bob');
    const mine = await sheets.readSheet('alice', table.id);
    const theirs = await sheets.readSheet('bob', copy.id);
    assert.deepStrictEqual(theirs.cells, mine.cells);
    assert.ok(await datatableStore.getDatatable(copy.id, datatableStore.userScope('bob')));
});

test('nobody else reads or writes the owner\'s table through this service', async () => {
    await assert.rejects(sheets.readSheet('mallory', table.id), (e) => e.status === 410 && e.code === 'sheet_table_missing');
    await assert.rejects(sheets.writeCells('mallory', table.id, { A1: 'x' }), (e) => e.status === 410);
});

test('a refused write changes nothing', async () => {
    await assert.rejects(sheets.writeCells('alice', table.id, { AA1: 'x' }), (e) => e.status === 400 && e.code === 'sheet_cell_out_of_range');
    await assert.rejects(sheets.writeCells('alice', table.id, { A1: 'x'.repeat(LIMITS.MAX_CELL_CHARS + 1) }), (e) => e.status === 413);
    assert.strictEqual((await sheets.readSheet('alice', table.id)).cells.A1, 'Rent');
});

test('dropping a sheet\'s table removes it and its rows', async () => {
    const spare = await sheets.createSheetTable({ ownerUserId: 'alice', name: 'Spare' });
    await sheets.writeCells('alice', spare.id, { A1: '1' });
    assert.strictEqual(await sheets.dropSheetTable('alice', spare.id), true);
    assert.strictEqual(await datatableStore.getDatatable(spare.id, datatableStore.userScope('alice')), null);
});

test('encrypted spreadsheet cells pass through the real compiler on insert, update and read', async () => {
    const encryption = require('../../stores/lib/documentCrypto');
    const { swap, restore } = require('../../testUtils/swaps').makeSwaps();
    const key = require('node:crypto').randomBytes(32);
    swap(encryption.keySources, 'policy', async () => ({ enabled: true, tier: 'managed' }));
    swap(encryption.keySources, 'userKey', async () => key);
    try {
        const encrypted = await sheets.createSheetTable({ ownerUserId: 'alice', name: 'Encrypted' });
        await require('../../stores/documentStore').createDocument({ userId: 'alice', docType: 'spreadsheet', sheetTableId: encrypted.id, settings: { houseStyle: false } });
        await sheets.writeCells('alice', encrypted.id, { A1: 'Confidential', B1: '=LEN(A1)', A2: 'x'.repeat(LIMITS.MAX_CELL_CHARS) });
        await sheets.writeCells('alice', encrypted.id, { A1: 'Updated' });
        const read = await sheets.readSheet('alice', encrypted.id);
        assert.strictEqual(read.cells.A1, 'Updated');
        assert.strictEqual(read.cells.B1, '=LEN(A1)');
        assert.strictEqual(read.cells.A2.length, LIMITS.MAX_CELL_CHARS);
    } finally { restore(); }
});
