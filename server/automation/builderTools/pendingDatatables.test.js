'use strict';

/**
 * Staging a table in a preview, and the pure helpers around the "pending:<n>"
 * ids. Staging goes through applyCreateDatatable (the real entry point) with a
 * createStudioDatatable that fails the test if it is ever called.
 */
const test = require('node:test');
const assert = require('node:assert');
const { applyCreateDatatable } = require('./datatableCreate');
const { normalizeFields } = require('../../core/dataEngine/dataModel/datatableFields');
const {
    isPendingDatatableId, nextPendingRef, pendingCatalogEntry, collectPendingRefs,
    rebindPendingDatatables, usedDatatables, withoutStagedTableIssues,
} = require('./pendingDatatables');

function deps(over = {}) {
    const calls = [];
    return {
        calls,
        createStudioDatatable: async () => { calls.push('create'); throw new Error('a staged table must never be created'); },
        resolvePrincipal: async (userId) => ({ userId, orgId: 'orgA' }),
        hasManageDatatables: async () => true,
        catalogFor: async () => [],
        defaultCreateScope: () => ({ kind: 'org', id: 'orgA' }),
        evaluateForRequest: async () => ({}),
        normalizeFields,
        ...over,
    };
}
const wrap = (over = {}) => ({
    userId: 'u1', _stageDatatables: true, _datatables: [], _pendingDatatables: [],
    _datatableCreate: { ok: true, scope: { kind: 'org', id: 'orgA' } }, ...over,
});
const FIELDS = [{ name: 'Datum', type: 'date' }, { name: 'Bedrag', type: 'number' }];

test('staging returns pending:1 with a pending catalog row and never creates a table', async () => {
    const d = deps();
    const w = wrap();
    const r = await applyCreateDatatable(w, { name: 'Facturen', fields: FIELDS }, d);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual([r.datatableId, r.datatableKey, r.staged], ['pending:1', 'facturen', true]);
    assert.match(r._next, /does NOT exist yet/);
    assert.deepStrictEqual(d.calls, []);
    assert.strictEqual(w._pendingDatatables.length, 1);
    const row = w._datatables.find((t) => t.id === 'pending:1');
    assert.ok(row && row.pending === true && row.canWrite === true);
    assert.deepStrictEqual(row.columns.map((c) => c.key), ['datum', 'bedrag']);
});

test('the key is unique against the catalog and against other pending tables', async () => {
    const w = wrap({ _datatables: [{ id: 'tbl_1', key: 'facturen', name: 'Oude facturen', columns: [], canWrite: true }] });
    const a = await applyCreateDatatable(w, { name: 'Facturen', fields: FIELDS }, deps());
    assert.strictEqual(a.datatableKey, 'facturen_2');
    const b = await applyCreateDatatable(w, { name: 'Factuur regels', key: 'facturen', fields: FIELDS }, deps());
    assert.strictEqual(b.datatableKey, 'facturen_3');
    assert.strictEqual(b.datatableId, 'pending:2');
});

test('the same name twice returns the same ref', async () => {
    const w = wrap();
    const a = await applyCreateDatatable(w, { name: 'Facturen', fields: FIELDS }, deps());
    const b = await applyCreateDatatable(w, { name: ' facturen ', fields: FIELDS }, deps());
    assert.strictEqual(a.datatableId, b.datatableId);
    assert.strictEqual(w._pendingDatatables.length, 1);
});

test('more than 5 new tables is refused', async () => {
    const w = wrap();
    for (let i = 1; i <= 5; i++) assert.ok(!(await applyCreateDatatable(w, { name: `Tabel ${i}`, fields: FIELDS }, deps())).error);
    const r = await applyCreateDatatable(w, { name: 'Tabel 6', fields: FIELDS }, deps());
    assert.match(r.error, /At most 5/);
    assert.strictEqual(w._pendingDatatables.length, 5);
});

test('a column list the engine would refuse is caught at stage time', async () => {
    const r = await applyCreateDatatable(wrap(), { name: 'Facturen', fields: FIELDS }, deps({ normalizeFields: () => ({ ok: false, error: 'Two columns both use the key "x"' }) }));
    assert.strictEqual(r.code, 'schema_invalid');
    assert.match(r._fixHint, /column list/);
});

test('an unreadable catalog stages nothing', async () => {
    const r = await applyCreateDatatable(wrap({ _datatables: null }), { name: 'Facturen', fields: FIELDS }, deps());
    assert.match(r.error, /could not be read/);
});

test('a failed access check at turn start refuses, but an unreadable identity stays permissive', async () => {
    const no = await applyCreateDatatable(wrap({ _datatableCreate: { ok: false, code: 'manage_datatables_required', message: 'You may not create organisation tables.' } }), { name: 'X', fields: FIELDS }, deps());
    assert.strictEqual(no.code, 'manage_datatables_required');
    assert.match(no._fixHint, /datatableIds/);
    const maybe = await applyCreateDatatable(wrap({ _datatableCreate: { ok: false, code: 'identity_unavailable', message: 'x' } }), { name: 'X', fields: FIELDS }, deps());
    assert.ok(!maybe.error, 'Apply checks again');
});

test('an existing same-named table is refused unless the user chose it', async () => {
    const existing = { id: 'tbl_1', key: 'facturen', name: 'Facturen', canWrite: true, columns: [{ key: 'datum', name: 'Datum', type: 'date' }] };
    const refused = await applyCreateDatatable(wrap({ _datatables: [existing], _approvedDatatableIds: new Set() }), { name: 'facturen', fields: FIELDS }, deps());
    assert.strictEqual(refused.code, 'datatable_choice_required');
    assert.deepStrictEqual(refused._askArgs.questions[0].datatableIds, ['tbl_1']);
    const w = wrap({ _datatables: [existing], _approvedDatatableIds: new Set(['tbl_1']) });
    const ok = await applyCreateDatatable(w, { name: 'facturen', fields: FIELDS }, deps());
    assert.deepStrictEqual([ok.datatableId, ok.exists, ok.staged], ['tbl_1', true, undefined]);
    assert.strictEqual(w._pendingDatatables.length, 0);
});

test('normalizeFields is idempotent: what Apply creates is what was staged', async () => {
    const w = wrap();
    await applyCreateDatatable(w, { name: 'Facturen', fields: [...FIELDS, { name: 'Status', type: 'select', options: ['open', 'paid'] }] }, deps());
    const staged = w._pendingDatatables[0].fields;
    assert.deepStrictEqual(normalizeFields(staged.map((f) => ({ ...f })), []).fields, staged);
});

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'a', type: 'datatable', op: 'add_row', datatableId: 'pending:1', datatableKey: 'facturen', values: {} },
        { id: 'l', type: 'loop', body: [{ id: 'b', type: 'datatable', op: 'find_rows', datatableId: 'pending:2' }] },
        { id: 'c', type: 'http_request', cacheInto: { datatableId: 'pending:3' } },
        { id: 'r', type: 'datatable', op: 'find_rows', datatableId: 'tbl_real' },
    ],
    layers: { sub: { steps: [{ id: 'd', type: 'datatable', op: 'find_rows', datatableId: 'pending:4' }], edges: [] } },
};

test('collectPendingRefs finds refs in the root, loop bodies, layers and cacheInto', () => {
    assert.deepStrictEqual([...collectPendingRefs(DEF)].sort(), ['pending:1', 'pending:2', 'pending:3', 'pending:4']);
    assert.strictEqual(collectPendingRefs({ steps: [] }).size, 0);
});

test('isPendingDatatableId and nextPendingRef', () => {
    assert.ok(isPendingDatatableId('pending:1') && isPendingDatatableId('pending:999'));
    for (const bad of ['pending:0', 'pending:', 'pending:1000', 'tbl_x', null, 'xpending:1']) assert.ok(!isPendingDatatableId(bad), String(bad));
    assert.strictEqual(nextPendingRef([]), 'pending:1');
    assert.strictEqual(nextPendingRef([{ ref: 'pending:1' }, { ref: 'pending:4' }]), 'pending:5');
});

test('rebindPendingDatatables replaces id and key, leaves real ids, does not mutate and reports unknown refs', () => {
    const snapshot = JSON.stringify(DEF);
    const map = new Map([['pending:1', { id: 'tbl_a', key: 'facturen_x' }], ['pending:2', { id: 'tbl_b', key: 'k2' }], ['pending:4', { id: 'tbl_d', key: 'k4' }]]);
    const { definition, unknownRefs } = rebindPendingDatatables(DEF, map);
    assert.strictEqual(JSON.stringify(DEF), snapshot, 'input untouched');
    assert.deepStrictEqual(unknownRefs, ['pending:3']);
    assert.deepStrictEqual([definition.steps[0].datatableId, definition.steps[0].datatableKey], ['tbl_a', 'facturen_x']);
    assert.strictEqual(definition.steps[1].body[0].datatableId, 'tbl_b');
    assert.strictEqual(definition.steps[3].datatableId, 'tbl_real');
    assert.strictEqual(definition.layers.sub.steps[0].datatableId, 'tbl_d');
    assert.strictEqual(definition.steps[2].cacheInto.datatableId, 'pending:3', 'unknown ref stays visible');
    assert.ok(!('datatableKey' in definition.steps[2].cacheInto));
});

test('usedDatatables marks pending and newly bound tables and lists the steps', () => {
    const base = { steps: [{ id: 'r', type: 'datatable', op: 'find_rows', datatableId: 'tbl_real' }] };
    const def = { steps: [
        { id: 'r', type: 'datatable', op: 'find_rows', datatableId: 'tbl_real' },
        { id: 'a', type: 'datatable', op: 'add_row', datatableId: 'pending:1', values: {} },
        { id: 'n', type: 'datatable', op: 'find_rows', datatableId: 'tbl_new' },
        { id: 'a2', type: 'datatable', op: 'add_row', datatableId: 'pending:1', values: {} },
    ] };
    const pending = [{ ref: 'pending:1', key: 'facturen', name: 'Facturen', fields: [], scope: 'org' }];
    const catalog = [{ id: 'tbl_real', key: 'real', name: 'Real' }, { id: 'tbl_new', key: 'nieuw', name: 'Nieuw' }];
    const used = usedDatatables(base, def, catalog, pending);
    assert.deepStrictEqual(used.map((u) => [u.id, u.pending, u.newlyBound, u.stepIds]), [
        ['pending:1', true, true, ['a', 'a2']],
        ['tbl_new', false, true, ['n']],
    ], 'the unchanged step on tbl_real is not listed');
    assert.strictEqual(used[0].name, 'Facturen');
    assert.strictEqual(used[1].name, 'Nieuw');
    const changed = usedDatatables(base, { steps: [{ id: 'r', type: 'datatable', op: 'count_rows', datatableId: 'tbl_real' }] }, catalog, []);
    assert.deepStrictEqual(changed.map((u) => [u.id, u.newlyBound]), [['tbl_real', false]]);
});

test('withoutStagedTableIssues drops only the staged refs and recomputes ok', () => {
    const v = { ok: false, errors: [
        { code: 'datatable.table_pending', ref: 'pending:1' },
        { code: 'datatable.table_pending', ref: 'pending:9' },
        { code: 'other.thing', ref: 'pending:1' },
    ], warnings: [] };
    const out = withoutStagedTableIssues(v, new Set(['pending:1']));
    assert.deepStrictEqual(out.errors.map((e) => e.ref + e.code), ['pending:9datatable.table_pending', 'pending:1other.thing']);
    assert.strictEqual(out.ok, false);
    const clean = withoutStagedTableIssues({ ok: false, errors: [{ code: 'datatable.table_pending', ref: 'pending:1' }], warnings: [] }, new Set(['pending:1']));
    assert.strictEqual(clean.ok, true);
});

test('pendingCatalogEntry has the shape of a real catalog row, flagged pending', () => {
    const row = pendingCatalogEntry({ ref: 'pending:2', key: 'k', name: 'N', description: 'd', scope: 'personal', fields: [{ key: 'a', name: 'A', type: 'text' }] });
    assert.deepStrictEqual(row, { id: 'pending:2', key: 'k', name: 'N', description: 'd', rowCount: 0, canWrite: true, managedKind: null, scope: 'personal', pending: true, columns: [{ key: 'a', name: 'A', type: 'text', unique: false }] });
});
