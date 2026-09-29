'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runTablePhase } = require('./tablePhase');
const recipe = require('../recipes/invoiceTracker');
const { normalizeFields } = require('../../core/dataEngine/dataModel/datatableFields');
const datatableAccess = require('../../auth/datatableAccess');

function deps(over = {}) {
    const calls = { created: [], invalidated: [], applied: [] };
    const d = {
        calls,
        db: { withTransaction: async (fn) => fn({ query: async () => ({ rows: [] }) }) },
        datatableStore: {
            listDatatablesForScope: async () => [{ id: 'tbl_old', key: 'facturen' }],
            createDatatable: async (args, { applyPhysical }) => {
                calls.created.push(args);
                await applyPhysical({ query: async () => ({}) }, { before: { tables: [] }, next: { tables: [{ id: 'tbl_new', key: args.key }] }, modelVersion: 1 });
                return { id: 'tbl_new', key: args.key, name: args.name };
            },
            getDatatable: async (id, scope) => (id === 'tbl_ex' && scope.kind === 'org' ? { id, key: 'nc_facturen', name: 'Facturen (NC)', managedKind: 'nextcloud_table', rowCount: 57, ownerUserId: 'u_other', sharedGroups: [] } : null),
            listGrants: async () => [],
            getTableMeta: async () => ({ fields: [
                { key: 'datum', name: 'Datum', type: 'date' }, { key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'factuurnummer', name: 'Factuurnummer', type: 'text' },
                { key: 'excl_btw', name: 'Excl. btw', type: 'number' }, { key: 'btw', name: 'Btw', type: 'number' }, { key: 'totaal', name: 'Totaal', type: 'number' },
            ] }),
        },
        datatableDbStore: { scopeKey: (s) => `${s.kind}:${s.id}`, applyMigration: async (...a) => { calls.applied.push(a); }, invalidate: (k) => { calls.invalidated.push(k); } },
        normalizeFields,
        migrationPlan: () => ['ALTER …'],
        ddlForTable: () => 'CREATE …',
        assertDatatableQuota: async () => {},
        datatableAccess: { ...datatableAccess, gradeForPrincipal: over.grade ? () => over.grade : datatableAccess.gradeForPrincipal },
        ...over.deps,
    };
    return d;
}
const principal = { userId: 'u1', orgId: 'org1', organizationId: 'org1', orgRole: 'admin', groupIds: [], orgIds: new Set(['org1']) };

test('new: creates the table in the default scope with the recipe schema, a key that avoids collisions, and reports the artifacts', async () => {
    const d = deps();
    const r = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'new', tableTitle: 'Facturen' } }, principal, recipe, hasManageDatatables: true }, d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(d.calls.created.length, 1);
    const args = d.calls.created[0];
    assert.equal(args.key, 'facturen_2', 'the scope already had "facturen"');
    assert.equal(args.name, 'Facturen');
    assert.equal(args.fields.length, 8);
    assert.deepEqual(args.fields.map((f) => f.key), recipe.INVOICE_SCHEMA.map((f) => f.key));
    assert.ok(args.description.length > 10, 'Art. 30 purpose');
    assert.deepEqual(args.scope, { kind: 'org', id: 'org1' });
    assert.equal(d.calls.applied.length, 1, 'physical DDL applied inside the transaction');
    assert.deepEqual(d.calls.invalidated, ['org:org1']);
    assert.deepEqual(r.artifacts, {
        datatableId: 'tbl_new', datatableKey: 'facturen_2', datatableName: 'Facturen', datatableScope: { kind: 'org', id: 'org1' },
        fields: args.fields.map((f) => ({ key: f.key, name: f.name, type: f.type })), mapping: recipe.schemaMapping(), isMirror: false, hasStatus: true, rowCount: 0,
    });
    assert.match(r.summary, /aangemaakt met 8 kolommen/);
});

test('new: an organisation scope needs manage_datatables; a personal principal creates in the account scope', async () => {
    const d = deps();
    const denied = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'new' } }, principal, recipe, hasManageDatatables: false }, d);
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'manage_datatables_required');
    const personal = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'new' } }, principal: { userId: 'u1', orgId: null, groupIds: [], orgIds: new Set() }, recipe, hasManageDatatables: false }, d);
    assert.equal(personal.ok, true);
    assert.deepEqual(d.calls.created[0].scope, { kind: 'user', id: 'u1' });
});

test('new: a key collision the DDL reports becomes key_taken and the engine memo is invalidated', async () => {
    const d = deps({ deps: { db: { withTransaction: async () => { const e = new Error('duplicate key value violates unique constraint "uq_datatables_scope_key"'); throw e; } } } });
    const r = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'new' } }, principal, recipe, hasManageDatatables: true }, d);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'key_taken');
    assert.deepEqual(d.calls.invalidated, ['org:org1']);
});

test('existing: an editor-grade Nextcloud mirror with the six titled columns is accepted with its mapping, flagged as mirror, no status', async () => {
    const d = deps({ grade: 'editor' });
    const r = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'existing', datatableId: 'tbl_ex' } }, principal, recipe }, d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.artifacts.datatableId, 'tbl_ex');
    assert.equal(r.artifacts.isMirror, true);
    assert.equal(r.artifacts.hasStatus, false);
    assert.equal(r.artifacts.rowCount, 57);
    assert.deepEqual(r.artifacts.mapping, { datum: 'datum', leverancier: 'leverancier', factuurnummer: 'factuurnummer', excl_btw: 'excl_btw', btw: 'btw', totaal: 'totaal' });
    assert.match(r.summary, /Nextcloud-spiegel/);
    assert.match(r.summary, /geen statuskolom/);
});

test('existing: a spreadsheet-file mirror is a mirror too — flagged, and named after its source, not after Nextcloud', async () => {
    // The phase asks the registry, never compares the kind string: a second
    // kind (core/dataEngine/sources/index.test.js) reaches it without a rename.
    const d = deps({ grade: 'editor' });
    d.datatableStore.getDatatable = async (id, scope) => (id === 'tbl_ex' && scope.kind === 'org' ? { id, key: 'ss_facturen', name: 'Facturen (sheet)', managedKind: 'spreadsheet_file', rowCount: 12, ownerUserId: 'u_other', sharedGroups: [] } : null);
    const r = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'existing', datatableId: 'tbl_ex' } }, principal, recipe }, d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.artifacts.isMirror, true);
    assert.equal(r.artifacts.mirrorKind, 'spreadsheet');
    assert.match(r.summary, /spreadsheet-spiegel/);
    assert.doesNotMatch(r.summary, /Nextcloud/);
    // A plain Studio table stays plain, and a managed kind that is not a
    // source kind (an HTTP cache) is not a mirror either.
    d.datatableStore.getDatatable = async (id, scope) => (id === 'tbl_ex' && scope.kind === 'org' ? { id, key: 'facturen', name: 'Facturen', managedKind: 'http_cache', rowCount: 3, ownerUserId: 'u_other', sharedGroups: [] } : null);
    const cache = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'existing', datatableId: 'tbl_ex' } }, principal, recipe }, d);
    assert.equal(cache.artifacts.isMirror, false);
    assert.equal(cache.artifacts.mirrorKind, null);
});

test('existing: reader grade is refused (the routine must write); a table without the required columns is unusable; an unknown id is not found; no id asks for one', async () => {
    const reader = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'existing', datatableId: 'tbl_ex' } }, principal, recipe }, deps({ grade: 'reader' }));
    assert.equal(reader.code, 'table_read_only');
    const d = deps({ grade: 'editor' });
    d.datatableStore.getTableMeta = async () => ({ fields: [{ key: 'datum', name: 'Datum', type: 'date' }] });
    const unusable = await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'existing', datatableId: 'tbl_ex' } }, principal, recipe }, d);
    assert.equal(unusable.code, 'table_unusable');
    assert.deepEqual(unusable.missing, ['leverancier', 'factuurnummer', 'excl_btw', 'totaal']);
    assert.equal((await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'existing', datatableId: 'tbl_nope' } }, principal, recipe }, deps())).code, 'table_not_found');
    assert.equal((await runTablePhase({ playbook: { userId: 'u1', options: { tableMode: 'existing' } }, principal, recipe }, deps())).code, 'table_required');
});

test('new: a retry REUSES the table the failed attempt created — never a second one', async () => {
    // The first attempt created the table and then failed (its closing save
    // lost a race); the failure kept the id and the retry route stashed it
    // under artifacts.previous (owner, 2026-09-17).
    const playbook = {
        userId: 'u1', options: { tableMode: 'new', tableTitle: 'Facturen' },
        phases: [{ key: 'table', kind: 'table', status: 'ready', attempt: 1, artifacts: { previous: { datatableId: 'tbl_prior' } } }],
    };
    const d = deps();
    d.datatableStore.getDatatable = async (id, scope) => (id === 'tbl_prior' && scope.kind === 'org' ? { id, key: 'facturen', name: 'Facturen', rowCount: 3 } : null);
    const r = await runTablePhase({ playbook, principal, recipe, hasManageDatatables: true }, d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.artifacts.datatableId, 'tbl_prior');
    assert.equal(r.artifacts.reused, true);
    assert.equal(r.artifacts.rowCount, 3);
    assert.equal(d.calls.created.length, 0, 'nothing created');
    // Gone since the attempt (or no longer fitting the recipe) → a fresh one.
    const gone = await runTablePhase({ playbook, principal, recipe, hasManageDatatables: true }, deps());
    assert.equal(gone.ok, true);
    assert.equal(gone.artifacts.datatableId, 'tbl_new', 'the prior table did not load, so a new one was created');
});
