/**
 * Studio tables in the processing register. Which tables are read is checked
 * on a real Postgres (the boot ladder's schema on PGlite, testUtils/pgliteDb.js);
 * the sentences built from a row get the row handed in.
 *
 * Run: node --test compliance/ropa/datatableActivities.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./datatableActivities');
const { pgliteDb } = require('../../testUtils/pgliteDb');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');

const ROW = {
    id: 'tbl_1', name: 'Invoices', description: null,
    scope_kind: 'org', scope_id: 'org1', organization_id: 'org1',
    lawful_basis: 'contract', retention_days: 365, retention_field: 'created_at',
    subject_column: 'supplier', row_scope: 'all', is_published: true, shared_groups: [], row_count: 32,
};
const FIELDS = [{ key: 'supplier', name: 'Leverancier' }, { key: 'email', name: 'E-mail' }, { key: 'total', name: 'Total' }];
const deps = (rows, fields = FIELDS) => ({
    getAll: async () => rows,
    getTableMeta: async () => ({ fields }),
});

test('a registered table becomes an activity with a real retention sentence and a source ref', async () => {
    const [a] = await R.datatableActivities('org1', deps([ROW]));
    assert.equal(a.activity_id, 'datatable:tbl_1');
    assert.equal(a.name, 'Invoices');
    assert.equal(a.legal_basis, 'contract');
    assert.match(a.retention, /365 days, deleted automatically on "created_at"/);
    assert.deepEqual(a.source, { kind: 'datatable', id: 'tbl_1', scope: { kind: 'org', id: 'org1' } });
    assert.deepEqual(a.data_categories, ['E-mail addresses'], 'from the columns, not from a constant');
    assert.match(a.data_subjects[0], /identified by "supplier"/);
    assert.equal(a.recipients, 'Everyone in this organisation');
});

test('only THIS organisation\'s tables, and only those someone recorded something about, oldest first', async () => {
    const { pg, db } = pgliteDb(ladderPglite());
    try {
        /** @param {Record<string, unknown>} over */
        const table = (over) => insertRow(pg, 'datatables', {
            scope_kind: 'org', scope_id: 'org1', owner_user_id: 'u1', organization_id: 'org1', key: String(over.id), name: String(over.id), ...over });
        await table({ id: 'tbl_new', lawful_basis: 'consent', created_at: '2026-02-01T00:00:00Z' });
        await table({ id: 'tbl_old', retention_days: 30, created_at: '2026-01-01T00:00:00Z' });
        await table({ id: 'tbl_nothing' });
        await table({ id: 'tbl_other_org', organization_id: 'org2', scope_id: 'org2', lawful_basis: 'contract' });
        const getAll = async (/** @type {string} */ sql, /** @type {unknown[]} */ params) => (await db.query(sql, params)).rows;
        const activities = await R.datatableActivities('org1', { getAll, getTableMeta: async () => ({ fields: FIELDS }) });
        assert.deepEqual(activities.map((x) => x.source.id), ['tbl_old', 'tbl_new']);
    } finally {
        await pg.close();
    }
});

test('no retention recorded says exactly that — never a promise nothing enforces', async () => {
    const [a] = await R.datatableActivities('org1', deps([{ ...ROW, retention_days: null, lawful_basis: 'consent' }]));
    assert.equal(a.retention, 'No retention recorded — nothing is deleted automatically.');
});

test('who receives it follows how the table is actually shared', async () => {
    const shared = await R.datatableActivities('org1', deps([{ ...ROW, shared_groups: ['g1'] }]));
    assert.match(shared[0].recipients, /groups this table is shared with/);
    const priv = await R.datatableActivities('org1', deps([{ ...ROW, is_published: false }]));
    assert.match(priv[0].recipients, /owner, and whoever holds an explicit grant/);
    const own = await R.datatableActivities('org1', deps([{ ...ROW, row_scope: 'own' }]));
    assert.ok(own[0].security_measures.some((m) => /only the rows they created/.test(m)));
});

test('a register that cannot read is short, never wrong', async () => {
    assert.deepEqual(await R.datatableActivities('org1', { getAll: async () => { throw new Error('no db'); } }), []);
    assert.deepEqual(await R.datatableActivities(null, deps([ROW])), []);
    // Columns that cannot be read still leave an activity — with an honest category line.
    const [a] = await R.datatableActivities('org1', { getAll: async () => [ROW], getTableMeta: async () => { throw new Error('gone'); } });
    assert.deepEqual(a.data_categories, ['Recorded in the table’s columns']);
});

test('categoriesOf reads the columns in both languages, and invents nothing', () => {
    assert.deepEqual(R.categoriesOf([{ key: 'naam' }, { key: 'iban' }]), ['Names', 'Bank details']);
    assert.deepEqual(R.categoriesOf([{ key: 'total' }, { key: 'amount' }]), []);
});
