'use strict';

/**
 * builder_update_step with a type change (patch.type, or patch.tool naming a
 * step type on an action) is performed as builder_replace_step. The measured
 * case: a Nextcloud Tables row step that must become a Bee Flow datatable step,
 * on a menu where builder_replace_step may not even be offered.
 */
const test = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition } = require('../builderTools');

const FACTUREN = {
    id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true, managedKind: null,
    columns: [{ key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'totaal', name: 'Totaal', type: 'number' }],
};
const lit = (value) => ({ kind: 'literal', value });

/** trg → ncRow (a Nextcloud Tables create_row action) → after (reads ncRow's output). */
function wrapWithNextcloudRow(extra = {}) {
    const def = emptyDefinition();
    def.steps = [
        {
            id: 'ncRow', type: 'integration_action', tool: 'nextcloud_tables_create_row', label: 'Save invoice',
            inputs: { tableId: lit('Facturen'), values: { Leverancier: lit('ACME'), Totaal: lit(12) } },
        },
        { id: 'after', type: 'set', label: 'Report', fields: { rowId: { kind: 'ref', path: 'steps.ncRow.output.rowId' } } },
    ];
    def.edges = [{ from: 'trg', to: 'ncRow' }, { from: 'ncRow', to: 'after' }];
    return { userId: 'u_test', def, _datatables: [FACTUREN], ...extra };
}

test('update_step {tool:"datatable", datatableId, values} turns a Nextcloud row step into a datatable step: same id, same edges', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', datatableId: 'tbl_1a2b3c', values: { leverancier: lit('ACME') } } }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.replacedType, { from: 'integration_action', to: 'datatable' });
    const step = dw.def.steps.find((s) => s.id === 'ncRow');
    assert.strictEqual(step.type, 'datatable');
    assert.strictEqual(step.op, 'add_row');
    assert.strictEqual(step.datatableId, 'tbl_1a2b3c');
    assert.strictEqual(step.datatableKey, 'facturen');
    assert.strictEqual(step.label, 'Save invoice', 'the label is kept');
    assert.deepStrictEqual(dw.def.edges.filter((e) => e.from === 'ncRow' || e.to === 'ncRow').map((e) => `${e.from}>${e.to}`), ['trg>ncRow', 'ncRow>after']);
    const warnings = r._warnings.join('\n');
    assert.match(warnings, /builder_update_step does not change a step's type, so this patch was applied as builder_replace_step\(newType:"datatable"\)/);
    assert.match(warnings, /op was not set: nextcloud_tables_create_row read as op "add_row"/);
    assert.match(warnings, /Steps after read this step's output; its shape changed/, 'readers of the old output are warned');
});

test('the old row values, keyed by column TITLE, are carried over and mapped to column keys', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', datatableId: 'tbl_1a2b3c' } }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(dw.def.steps[0].values), ['leverancier', 'totaal']);
    assert.match(r._warnings.join('\n'), /row values of the old step were carried over/);
});

test('{type:"datatable"} behaves the same as {tool:"datatable"}', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { type: 'datatable', op: 'add_row', datatableId: 'tbl_1a2b3c', values: { leverancier: lit('x') } } }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.replacedType, { from: 'integration_action', to: 'datatable' });
    assert.strictEqual(dw.def.steps[0].type, 'datatable');
});

test('inputs.{op,values,datatableId} are lifted; the Nextcloud inputs.tableId is NEVER used as the Bee Flow table, even when a table of that name exists', async () => {
    const dw = wrapWithNextcloudRow();
    // No datatableId anywhere: "Facturen" is the Nextcloud tableId and a Bee Flow table "Facturen" exists.
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', inputs: { tableId: 'Facturen', op: 'add_row' } } }, dw);
    assert.ok(r.error, 'no table was chosen, so it is refused');
    assert.strictEqual(dw.def.steps[0].type, 'integration_action', 'the step is untouched');
    assert.notStrictEqual(dw.def.steps[0].datatableId, 'tbl_1a2b3c');

    const lifted = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', inputs: { op: 'add_row', datatableId: 'tbl_1a2b3c', values: { leverancier: lit('Z') }, tableId: 'Facturen' } } }, dw);
    assert.ok(!lifted.error, JSON.stringify(lifted));
    assert.strictEqual(dw.def.steps[0].datatableId, 'tbl_1a2b3c');
    assert.match(lifted._warnings.join('\n'), /Nextcloud tableId .* were not carried over/);
});

test('a type change without a table names builder_replace_step and never builder_add_datatable', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', op: 'add_row' } }, dw);
    assert.ok(r.error);
    assert.match(r._fixHint, /builder_replace_step\(\{stepId:"ncRow", newType:"datatable", spec:\{op, datatableId, datatableKey, values\}\}\)/);
    assert.match(r._fixHint, /never from the Nextcloud tableId/);
    assert.doesNotMatch(r._fixHint, /builder_add_datatable/);
});

test('without builder_replace_step on the menu the hint shows the patch-type form', async () => {
    const dw = wrapWithNextcloudRow({ _offeredTools: new Set(['builder_update_step', 'builder_add_datatable']) });
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', op: 'add_row' } }, dw);
    assert.match(r._fixHint, /builder_update_step\(\{stepId:"ncRow", patch:\{type:"datatable", op, datatableId, datatableKey, values\}\}\)/);
    assert.doesNotMatch(r._fixHint, /builder_replace_step/);
    const withReplace = wrapWithNextcloudRow({ _offeredTools: new Set(['builder_replace_step']) });
    const r2 = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', op: 'add_row' } }, withReplace);
    assert.match(r2._fixHint, /builder_replace_step\(/);
});

test('an unchosen existing table keeps its consent question through a type change', async () => {
    const dw = wrapWithNextcloudRow({ _approvedDatatableIds: new Set() });
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'datatable', datatableId: 'tbl_1a2b3c' } }, dw);
    assert.strictEqual(r.code, 'datatable_choice_required');
    assert.ok(r._askArgs);
    assert.strictEqual(dw.def.steps[0].type, 'integration_action');
});

test('a step inside a loop body gets a clear refusal', async () => {
    const def = emptyDefinition();
    def.steps = [{ id: 'lp', type: 'loop', overRef: 'trigger.output.items', itemVar: 'it', body: [{ id: 'inner', type: 'integration_action', tool: 'nextcloud_tables_create_row', inputs: {} }] }];
    def.edges = [{ from: 'trg', to: 'lp' }];
    const dw = { userId: 'u_test', def, _datatables: [FACTUREN] };
    const r = await applyToolCall('builder_update_step', { stepId: 'inner', patch: { tool: 'datatable', datatableId: 'tbl_1a2b3c', op: 'add_row' } }, dw);
    assert.match(r.error, /inside a loop body/);
    assert.match(r.error, /builder_replace_step\(\{stepId:"lp", newType:"loop"/);
});

test('builder_update_steps routes an entry the same way', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_update_steps', { updates: [{ stepId: 'ncRow', patch: { tool: 'datatable', datatableId: 'tbl_1a2b3c', values: { leverancier: lit('Q') } } }] }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.updated, ['ncRow']);
    assert.strictEqual(dw.def.steps[0].type, 'datatable');
    assert.match(r._warnings.join('\n'), /applied as builder_replace_step/);
});

test('a type that cannot be replaced into keeps the refusal, with the allowed types', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { type: 'trigger' } }, dw);
    assert.match(r.error, /Cannot change a step's type to "trigger"\. Allowed types: .*datatable/);
});

test('restating the same type is not a type change', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { type: 'integration_action', label: 'Renamed' } }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(dw.def.steps[0].label, 'Renamed');
    assert.strictEqual(r.replacedType, undefined);
});

test('a catalog tool that happens to share a step type name stays a tool patch', async () => {
    const dw = wrapWithNextcloudRow({ _availableToolNames: new Set(['filter', 'nextcloud_tables_create_row']), _inputSchemasByTool: { filter: { type: 'object', properties: {} } } });
    const r = await applyToolCall('builder_update_step', { stepId: 'ncRow', patch: { tool: 'filter' } }, dw);
    assert.strictEqual(r.replacedType, undefined);
});

test('replace_step with newType integration_action and a step-type tool name hints newType:"datatable"', async () => {
    const dw = wrapWithNextcloudRow();
    const r = await applyToolCall('builder_replace_step', { stepId: 'ncRow', newType: 'integration_action', spec: { tool: 'datatable', inputs: {} } }, dw);
    assert.match(r.error, /"datatable" is a step type, not a tool/);
    assert.match(r._fixHint, /newType:"datatable"|Use newType:"datatable"/);
});

test('replace_step from an action to a datatable keeps upstream value bindings and warns the readers', async () => {
    const def = emptyDefinition();
    def.steps = [
        { id: 'src', type: 'http_request', url: 'https://api.example.com/x', method: 'GET' },
        { id: 'row', type: 'integration_action', tool: 'nextcloud_tables_create_row', inputs: {} },
        { id: 'tail', type: 'set', fields: { r: { kind: 'ref', path: 'steps.row.output.rowId' } } },
    ];
    def.edges = [{ from: 'trg', to: 'src' }, { from: 'src', to: 'row' }, { from: 'row', to: 'tail' }];
    const dw = { userId: 'u_test', def, _datatables: [FACTUREN] };
    const r = await applyToolCall('builder_replace_step', {
        stepId: 'row', newType: 'datatable',
        spec: { op: 'add_row', datatableId: 'tbl_1a2b3c', values: { leverancier: { kind: 'ref', path: 'steps.src.output.body' } } },
    }, dw);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(dw.def.steps[1].values.leverancier, { kind: 'ref', path: 'steps.src.output.body' });
    assert.match((r._warnings || []).join('\n'), /Steps tail read this step's output; its shape changed \(a datatable add_row returns row, id, created, updated\)/);
});

test('a refusal inside builder_update_steps keeps the entry\'s own hint and consent question', async () => {
    const dw = wrapWithNextcloudRow({ _approvedDatatableIds: new Set() });
    const asked = await applyToolCall('builder_update_steps', { updates: [{ stepId: 'ncRow', patch: { tool: 'datatable', datatableId: 'tbl_1a2b3c' } }] }, dw);
    assert.match(asked.error, /update for "ncRow"/);
    assert.strictEqual(asked.code, 'datatable_choice_required');
    assert.ok(asked._askArgs);
    const noTable = await applyToolCall('builder_update_steps', { updates: [{ stepId: 'ncRow', patch: { tool: 'datatable', op: 'add_row' } }] }, wrapWithNextcloudRow());
    assert.match(noTable._fixHint, /builder_replace_step\(\{stepId:"ncRow"/);
    assert.strictEqual(noTable._rolledBack, true);
});
