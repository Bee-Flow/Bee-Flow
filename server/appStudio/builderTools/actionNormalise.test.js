'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { repairAction, describeActionRefusal, CREATE_RECIPE } = require('./actionNormalise');
const { suggestTableId, tableHandle } = require('./tableHints');

const TABLES = [
    { id: 'tbl_ab12cd', key: 'suppliers', name: 'Suppliers', fields: [{ key: 'name' }, { key: 'email' }, { key: 'category' }] },
    { id: 'tbl_ef34gh', key: 'invoices', name: 'Invoices', fields: [{ key: 'amount' }, { key: 'due_date' }, { key: 'invoice_no' }, { key: 'supplier_id' }] },
];

// ── tableHints ──────────────────────────────────────────────────────────────

test('tableHandle strips the prefix and a trailing counter', () => {
    assert.equal(tableHandle('tbl_suppliers_01'), 'suppliers');
    assert.equal(tableHandle('tbl_invoices-2'), 'invoices');
    assert.equal(tableHandle('Suppliers'), 'suppliers');
    assert.equal(tableHandle('tbl_ab12cd'), 'ab12cd');
});

test('suggestTableId: a handle that names exactly one table resolves by key or by name slug; anything else is null', () => {
    assert.equal(suggestTableId('tbl_suppliers_01', TABLES).table.id, 'tbl_ab12cd');
    assert.equal(suggestTableId('tbl_suppliers_01', TABLES).via, 'key');
    assert.equal(suggestTableId('tbl_ab12cd', TABLES).via, 'id');
    assert.equal(suggestTableId('tbl_invoices', TABLES).table.id, 'tbl_ef34gh');
    const byName = [{ id: 'tbl_x', key: 'lev', name: 'Leveranciers' }];
    assert.equal(suggestTableId('tbl_leveranciers_01', byName).via, 'name');
    assert.equal(suggestTableId('tbl_orders', TABLES), null, 'no such table');
    assert.equal(suggestTableId('tbl_suppliers_01', [...TABLES, { id: 'tbl_zz', key: 'suppliers', name: 'Other' }]), null, 'two candidates → nothing');
    assert.equal(suggestTableId('', TABLES), null);
    assert.equal(suggestTableId('tbl_suppliers_01', []), null);
});

// ── repairAction: the four shapes of the 2026-09-13 trace ───────────────────

test('shape (a): inputMapping + onSuccess on a create_record becomes a sequence with form.<name> values, a refresh and the toast', () => {
    const { action, notes, refusal } = repairAction({
        kind: 'create_record',
        inputMapping: {
            amount: { kind: 'field', name: 'amount', formId: 'cmp_bst9vt' },
            due_date: { kind: 'field', name: 'due_date', formId: 'cmp_bst9vt' },
        },
        onSuccess: { toast: { message: 'Invoice registered!', tone: 'success' } },
        tableId: 'tbl_invoices_01',
    }, { tables: TABLES });
    assert.equal(refusal, null);
    assert.deepEqual(action, {
        kind: 'sequence',
        steps: [
            { kind: 'create_record', tableId: 'tbl_ef34gh', values: { amount: { kind: 'formula', expr: 'form.amount' }, due_date: { kind: 'formula', expr: 'form.due_date' } } },
            { kind: 'refresh', tableId: 'tbl_ef34gh' },
            { kind: 'toast', message: 'Invoice registered!', tone: 'success' },
        ],
    });
    assert.ok(notes.some((n) => /"inputMapping" read as "values"/.test(n)));
    assert.ok(notes.some((n) => /kind:"field", name:"amount"\} read as \{kind:"formula", expr:"form\.amount"\}/.test(n)));
    assert.ok(notes.some((n) => /"tbl_invoices_01" is not a table — read as tbl_ef34gh \(key invoices\)/.test(n)));
    assert.ok(notes.some((n) => /read as a sequence \[create_record, refresh, toast\]/.test(n)));
});

test('shape (b): a values entry that is a STRING carrying binding JSON is parsed back into its binding (2026-09-14); an unparseable one is still refused as corrupted', () => {
    const ok = repairAction({
        kind: 'create_record', tableId: 'tbl_suppliers_01',
        values: { category: '{kind:\\"field\\",name:\\"category\\",formId:\\"cmp_bslzxp\\"}`,email:' },
        resultVar: 'sup_res',
    }, { tables: TABLES });
    assert.ok(!ok.refusal, JSON.stringify(ok.refusal));
    assert.deepEqual(ok.action.values.category, { kind: 'formula', expr: 'form.category' });
    assert.ok(ok.notes.some((n) => /action\.values\.category arrived as a string carrying binding JSON — read as the binding \{kind:"field"/.test(n)), JSON.stringify(ok.notes));
    const noName = repairAction({ kind: 'create_record', tableId: 'tbl_ab12cd', values: { x: '{kind:"static"' } }, { tables: TABLES });
    assert.ok(noName.refusal && !noName.refusal._suggestedPatch, 'unparseable → refused, no name → no patch');
    assert.match(noName.refusal.error, /action\.values\.x is a STRING carrying binding JSON/);
});

test('shape (c): {kind:"field"} inside values becomes form.<name>; a field without a usable name is refused, never guessed from the key', () => {
    const ok = repairAction({ kind: 'create_record', tableId: 'tbl_ab12cd', values: { category: { kind: 'field', name: 'category', formId: 'cmp_1' } } }, { tables: TABLES });
    assert.deepEqual(ok.action.values.category, { kind: 'formula', expr: 'form.category' });
    const bad = repairAction({ kind: 'create_record', tableId: 'tbl_ab12cd', values: { category: { kind: 'field', formId: 'cmp_1' } } }, { tables: TABLES });
    assert.ok(bad.refusal);
    assert.match(bad.refusal._fixHint, /Reject reason: action\.values\.category has kind:"field" without a usable name/);
    assert.equal(bad.refusal._suggestedPatch, undefined);
});

test('shape (d): forms.<form>.<field> in a server step becomes form.<field> (also inside a function call); client-only roots are refused', () => {
    const { action, notes } = repairAction({
        kind: 'create_record', tableId: 'tbl_ab12cd',
        values: { category: { kind: 'formula', expr: 'forms.supplier_form.category' }, total: { kind: 'formula', expr: 'number(forms.f.amount) * 1.21' } },
    }, { tables: TABLES });
    assert.equal(action.values.category.expr, 'form.category');
    assert.equal(action.values.total.expr, 'number(form.amount) * 1.21');
    assert.ok(notes.some((n) => /would write NULL/.test(n)));
    for (const root of ['screen.params.id', 'actions.act_1.result', 'records.tbl_ab12cd[0].id', 'datasets.d1.total']) {
        const r = repairAction({ kind: 'create_record', tableId: 'tbl_ab12cd', values: { x: { kind: 'formula', expr: root } } }, { tables: TABLES });
        assert.ok(r.refusal, root);
        assert.match(r.refusal._fixHint, /which a create\/update\/delete step cannot see/);
    }
});

test('bare scalars become static bindings; a string that IS a scope path becomes a formula; a bare record action without effects keeps its kind', () => {
    const { action, notes, refusal } = repairAction({
        kind: 'create_record', tableId: 'tbl_ab12cd',
        values: { name: 'Acme', n: 5, ok: true, nothing: null, total: 'form.total', who: 'currentUser.id' },
    }, { tables: TABLES });
    assert.equal(refusal, null);
    assert.equal(action.kind, 'create_record', 'no effects → not wrapped');
    assert.deepEqual(action.values, {
        name: { kind: 'static', value: 'Acme' },
        n: { kind: 'static', value: 5 },
        ok: { kind: 'static', value: true },
        nothing: { kind: 'static', value: null },
        total: { kind: 'formula', expr: 'form.total' },
        who: { kind: 'formula', expr: 'currentUser.id' },
    });
    assert.equal(notes.length, 6);
});

test('inside a sequence: a record step with onSuccess gets its refresh and toast spliced after it (no second refresh when one already follows)', () => {
    const { action, notes } = repairAction({
        kind: 'sequence',
        steps: [
            { kind: 'create_record', tableId: 'tbl_ab12cd', values: { name: { kind: 'field', name: 'name' } }, onSuccess: { toast: { message: 'Saved' } } },
            { kind: 'refresh', tableId: 'tbl_ab12cd' },
        ],
    }, { tables: TABLES });
    assert.deepEqual(action.steps.map((s) => s.kind), ['create_record', 'toast', 'refresh']);
    assert.equal(action.steps[0].onSuccess, undefined);
    assert.deepEqual(action.steps[0].values.name, { kind: 'formula', expr: 'form.name' });
    assert.ok(notes.some((n) => /action\.steps\[0\]\.values\.name/.test(n)));
    // update_record: recordId is a binding too.
    const upd = repairAction({ kind: 'sequence', steps: [{ kind: 'update_record', tableId: 'tbl_ab12cd', recordId: 'form.item.id', values: { name: { kind: 'field', name: 'name' } } }] }, { tables: TABLES });
    assert.deepEqual(upd.action.steps[0].recordId, { kind: 'formula', expr: 'form.item.id' });
});

test('nothing to repair → the action comes back deep-equal with no notes; run_automation keeps its own vocabulary', () => {
    const clean = { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 'tbl_ab12cd', values: { name: { kind: 'formula', expr: 'form.name' } } }, { kind: 'refresh', tableId: 'tbl_ab12cd' }] };
    const r = repairAction(clean, { tables: TABLES });
    assert.deepEqual(r.action, clean);
    assert.deepEqual(r.notes, []);
    const ra = { kind: 'run_automation', automationId: 'a1', inputMapping: { q: { kind: 'field', name: 'q' } }, onError: { toast: { message: 'x' } } };
    assert.deepEqual(repairAction(ra, { tables: TABLES }).action, ra);
    const garbled = repairAction({ kind: 'run_automation', automationId: 'a1', inputMapping: { q: '{kind:"field"' } }, {});
    assert.match(garbled.refusal._fixHint, /corrupted JSON in action\.inputMapping\.q/);
    assert.deepEqual(repairAction(null).action, null);
});

test('a tableId handle is only rewritten when it names exactly one table; unknown ids are left for the validator', () => {
    const r = repairAction({ kind: 'create_record', tableId: 'tbl_orders_01', values: {} }, { tables: TABLES });
    assert.equal(r.action.tableId, 'tbl_orders_01');
    assert.deepEqual(r.notes, []);
    const none = repairAction({ kind: 'create_record', tableId: 'tbl_suppliers_01', values: {} }, { tables: [] });
    assert.equal(none.action.tableId, 'tbl_suppliers_01', 'zero tables: nothing to resolve against');
});

// ── describeActionRefusal ───────────────────────────────────────────────────

test('an unknown table becomes a "Reject reason" naming both creators, with the zero-tables clause and a patch only when the fix is known', () => {
    const errors = [{ code: 'step.unknown_table', path: 'actions.act_1.tableId', message: 'Action "act_1" (create_record) references table "tbl_suppliers_01" which does not exist in the app\'s data model.', hint: 'The app has no data tables yet — create the table first.' }];
    const zero = describeActionRefusal(errors, { actionId: 'act_1', action: { kind: 'create_record', tableId: 'tbl_suppliers_01' }, tables: [] });
    assert.match(zero._fixHint, /^Reject reason: table "tbl_suppliers_01" is not in the app \(it has no tables yet\)\./);
    assert.match(zero._fixHint, /app_upsert_table \{name, fields:\[\{key,type\}\]\}/);
    assert.match(zero._fixHint, /app_link_datatable \{name\}/);
    assert.match(zero._fixHint, /never invent a tbl_ id/);
    assert.equal(zero._suggestedPatch, undefined);
    const dym = describeActionRefusal([{ ...errors[0], hint: 'Did you mean "tbl_ab12cd"?' }], { actionId: 'act_1', action: { kind: 'create_record', tableId: 'tbl_suppliers_01' }, tables: TABLES });
    assert.deepEqual(dym._suggestedPatch.ops, [{ op: 'set', path: 'action.tableId', value: 'tbl_ab12cd' }]);
    assert.match(dym._fixHint, /Did you mean "tbl_ab12cd"\?/);
});

test('unknown fields quote the create_record recipe; an invalid binding names the two legal shapes and patches from the object\'s name', () => {
    const uf = describeActionRefusal([{ code: 'action.unknown_field', path: 'actions.act_1', message: 'Action "act_1" has unknown fields for kind "create_record": inputMapping, onSuccess.', hint: 'Legal fields: tableId, values, resultVar.' }], { actionId: 'act_1', action: {}, tables: TABLES });
    assert.match(uf._fixHint, /inputMapping, onSuccess/);
    assert.ok(uf._fixHint.includes(CREATE_RECIPE));
    const kind = describeActionRefusal([{ code: 'binding.kind_invalid', path: 'actions.act_1.values.category.kind', message: 'Unknown binding kind "field".' }], { actionId: 'act_1', action: { values: { category: { kind: 'field', name: 'category' } } }, tables: TABLES });
    assert.match(kind._fixHint, /action\.values\.category must be a binding object/);
    assert.deepEqual(kind._suggestedPatch.ops, [{ op: 'set', path: 'action.values.category', value: { kind: 'formula', expr: 'form.category' } }]);
});

test('an unknown values column with a did-you-mean becomes a move op; anything unrecognised falls back to the generic line', () => {
    const uf = describeActionRefusal([{ code: 'step.unknown_field', path: 'actions.act_1.values.emial', message: 'Action "act_1" (create_record) references field "emial" which is not on table "tbl_ab12cd".', hint: 'Did you mean "email"?' }], { actionId: 'act_1', action: {}, tables: TABLES });
    assert.deepEqual(uf._suggestedPatch.ops, [{ op: 'move', from: 'action.values.emial', to: 'action.values.email' }]);
    assert.match(uf._fixHint, /its keys: name, email, category/);
    const other = describeActionRefusal([{ code: 'action.toast_message_missing', path: 'actions.act_1.message', message: 'x' }], { actionId: 'act_1', action: {}, tables: [] });
    assert.equal(other._fixHint, 'Fix the fields the errors name and call app_set_action again with the whole action.');
    assert.equal(other._suggestedPatch, undefined);
});
