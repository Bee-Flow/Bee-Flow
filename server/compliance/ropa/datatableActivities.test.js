/**
 * Studio tables in the processing register.
 *
 * Run: node --test --test-force-exit compliance/ropa/datatableActivities.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./datatableActivities');

const ROW = {
    id: 'tbl_1', name: 'Invoices', description: null,
    scope_kind: 'org', scope_id: 'org1', organization_id: 'org1',
    lawful_basis: 'contract', retention_days: 365, retention_field: 'created_at',
    subject_column: 'supplier', row_scope: 'all', is_published: true, shared_groups: [], row_count: 32,
};
const FIELDS = [{ key: 'supplier', name: 'Leverancier' }, { key: 'email', name: 'E-mail' }, { key: 'total', name: 'Total' }];
const deps = (rows, fields = FIELDS) => ({
    getAll: async (sql, params) => { deps.last = { sql, params }; return rows; },
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
    // The query only asks for THIS organisation, and only for rows someone recorded something about.
    assert.match(deps.last.sql, /organization_id = \$1/);
    assert.match(deps.last.sql, /lawful_basis IS NOT NULL OR retention_days IS NOT NULL/);
    assert.deepEqual(deps.last.params, ['org1']);
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
