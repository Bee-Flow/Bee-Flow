const test = require('node:test');
const assert = require('node:assert/strict');
const { checkComponentDataRefs, guardResult } = require('./bindingGuard');

const MODEL = { tables: [{
    id: 'tbl_fact', key: 'facturen', name: 'Facturen',
    source: { kind: 'datatable', datatableId: 'tbl_src', mode: 'read' },
    fields: [{ key: 'datum', type: 'date' }, { key: 'leverancier', type: 'text' }, { key: 'excl_btw', type: 'number' }, { key: 'totaal', type: 'number' }],
}, { id: 'tbl_own', key: 'notes', fields: [{ key: 'body', type: 'text' }] }] };

test('the column TITLE where the KEY belongs is caught with the key as the suggestion', () => {
    const entries = [
        { type: 'stat', props: { value: { kind: 'aggregate', tableId: 'tbl_fact', aggregates: [{ fn: 'sum', field: 'Excl. btw', as: 'total' }], pick: { row: 'first', column: 'total' } } } },
        { type: 'data_grid', props: { data: { kind: 'records', tableId: 'facturen', sort: [{ field: 'Datum', dir: 'desc' }], filter: [{ field: 'exclBtw', op: 'gt', value: 0 }] }, columns: [{ key: 'datum' }, { key: 'Leverancier' }, { key: 'totaal' }] } },
    ];
    const { errors } = checkComponentDataRefs(entries, MODEL);
    assert.deepEqual(errors.map((e) => [e.index, e.path]), [
        [0, 'components[0].props.value.aggregates[0].field'],
        [1, 'components[1].props.data.filter[0].field'],
        [1, 'components[1].props.data.sort[0].field'],
        [1, 'components[1].props.columns[1].key'],
    ]);
    assert.match(errors[0].hint, /Did you mean "excl_btw"\?/);
    assert.match(errors[0].hint, /linked table — keys are the source column titles/);
    assert.match(errors[2].hint, /Did you mean "datum"\?/);
    const r = guardResult({ errors });
    assert.equal(r.failedIndex, 0);
    assert.match(r.error, /4 data references in components would fail at run time — nothing was added/);
});

test('correct keys, system columns, aggregate aliases in sort, and a table by key all pass; unknown table is named', () => {
    const ok = [{ type: 'data_grid', props: { data: { kind: 'records', tableId: 'facturen', sort: [{ field: 'created_at' }], filter: [{ field: 'leverancier', op: 'contains', value: { kind: 'formula', expr: 'vars.filters.leverancier' } }] }, columns: [{ key: 'datum' }, { key: 'totaal' }] } },
        { type: 'chart', props: { data: { kind: 'aggregate', tableId: 'tbl_fact', groupBy: [{ field: 'datum', bucket: 'month', as: 'maand' }], aggregates: [{ fn: 'sum', field: 'totaal', as: 'som' }], sort: [{ field: 'maand' }] } } },
        { type: 'card', children: [{ type: 'record_detail', props: { record: { kind: 'record', tableId: 'tbl_own', filter: [{ field: 'body', op: 'eq', value: 'x' }] } } }] },
    ];
    assert.deepEqual(checkComponentDataRefs(ok, MODEL).errors, []);
    const bad = [{ type: 'data_grid', props: { data: { kind: 'records', tableId: 'tbl_invoices' } } }];
    const { errors } = checkComponentDataRefs(bad, MODEL);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /names table "tbl_invoices", which this app does not have/);
    assert.match(errors[0].hint, /app_link_datatable/);
});

test('no model loaded this turn → no opinion; a model with no tables still refuses a binding', () => {
    const entries = [{ type: 'data_grid', props: { data: { kind: 'records', tableId: 'tbl_x' } } }];
    assert.deepEqual(checkComponentDataRefs(entries, undefined).errors, []);
    assert.equal(checkComponentDataRefs(entries, null).errors.length, 1);
    assert.match(checkComponentDataRefs(entries, { tables: [] }).errors[0].hint, /\(none — the app has no tables\)/);
    assert.equal(guardResult({ errors: [] }), null);
});

// ── input_relation.props.tableId (2026-09-13) ──────────────────────────────
// A plain-string table reference the guard never read: four relation inputs
// on an invented `tbl_suppliers_01` passed add time and failed at finalize.
test('an input_relation naming a table the app does not have is refused like a binding, with both creators in the hint', () => {
    const { errors, repairs } = checkComponentDataRefs([
        { type: 'form', props: { name: 'f' }, children: [{ type: 'input_relation', props: { name: 'sup', label: 'Supplier', tableId: 'tbl_orders_01' } }] },
    ], MODEL);
    assert.deepEqual(repairs, []);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'components[0].children[0].props.tableId');
    assert.match(errors[0].message, /input_relation names table "tbl_orders_01", which this app does not have/);
    assert.match(errors[0].hint, /app_upsert_table \{name, fields:\[\{key,type\}\]\}/);
    assert.match(errors[0].hint, /app_link_datatable \{name\}/);
    assert.match(errors[0].hint, /never invent one/);
    const out = guardResult({ errors });
    assert.match(out._fixHint, /^Reject reason: input_relation names table "tbl_orders_01"/);
    // Zero tables: same refusal, "(none …)" list.
    const none = checkComponentDataRefs([{ type: 'input_relation', props: { name: 'x', tableId: 'tbl_suppliers_01' } }], null);
    assert.equal(none.errors.length, 1);
    assert.match(none.errors[0].hint, /Tables: \(none — the app has no tables\)/);
});

test('an input_relation whose tableId is a HANDLE for exactly one table is repaired in place and noted; its displayField is checked against that table', () => {
    const entries = [{ type: 'input_relation', props: { name: 'sup', label: 'Note', tableId: 'tbl_notes_01', displayField: 'body' } }];
    const { errors, repairs } = checkComponentDataRefs(entries, MODEL);
    assert.deepEqual(errors, []);
    assert.equal(entries[0].props.tableId, 'tbl_own', 'rewritten on the entry the caller builds from');
    assert.match(repairs[0], /components\[0\]\.props\.tableId "tbl_notes_01" is not a table — read as tbl_own \(key notes\)/);
    const bad = checkComponentDataRefs([{ type: 'input_relation', props: { name: 'sup', tableId: 'tbl_own', displayField: 'Body' } }], MODEL);
    assert.equal(bad.errors.length, 1);
    assert.equal(bad.errors[0].path, 'components[0].props.displayField');
    assert.match(bad.errors[0].hint, /Did you mean "body"\?/);
    // A binding's invented table id gets the same handle as its did-you-mean.
    const b = checkComponentDataRefs([{ type: 'data_grid', props: { data: { kind: 'records', tableId: 'tbl_facturen_01' } } }], MODEL);
    assert.equal(b.errors[0].suggestion, 'tbl_fact');
    assert.match(b.errors[0].hint, /Did you mean "tbl_fact"\?/);
});
