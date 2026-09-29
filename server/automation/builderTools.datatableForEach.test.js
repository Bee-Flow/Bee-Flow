'use strict';

/**
 * Datatable steps iterate (2026-09-04): builder_add_datatable keeps the forEach
 * it is given, and the validator accepts it. Until now the schema advertised
 * forEach, applyAddDatatable dropped it on the floor and validate.js rejected
 * it if it ever got there — so "one row per accepted item" writes ran ONCE
 * with loop.<item> undefined and nobody was told.
 *
 * Run: node --test --test-force-exit automation/builderTools.datatableForEach.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { applyToolCall, emptyDefinition } = require('./builderTools');
const { validateDefinition } = require('./validate');

function wrap(def) { return { def, userId: 'u1', automationId: 'a1' }; }

async function build() {
    const def = emptyDefinition();
    const w = wrap(def);
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, w);
    await applyToolCall('builder_add_set', { label: 'List', fields: { items: { kind: 'expr', value: 'split("a,b", ",")' } } }, w);
    return w;
}

test('builder_add_datatable keeps forEach and the definition validates', async () => {
    const w = await build();
    const listId = w.def.steps.find(s => s.type === 'set').id;
    const r = await applyToolCall('builder_add_datatable', {
        op: 'save_row', datatableId: 'tbl_x', datatableKey: 'x', matchColumn: 'pattern',
        forEach: { overRef: `steps.${listId}.output.items`, itemVar: 'rule', maxIterations: 5 },
        values: { pattern: '{{loop.rule}}' },
    }, w);
    assert.ok(r.added, JSON.stringify(r));
    assert.deepStrictEqual(r.added.forEach, { overRef: `steps.${listId}.output.items`, itemVar: 'rule', maxIterations: 5 });

    const v = validateDefinition(w.def, { deliverableEvents: [] });
    const feErrors = (v.errors || []).filter(e => String(e.code).startsWith('foreach'));
    assert.deepStrictEqual(feErrors, [], JSON.stringify(v.errors));
});

test('a datatable step patched with forEach validates too', async () => {
    const w = await build();
    const listId = w.def.steps.find(s => s.type === 'set').id;
    const r = await applyToolCall('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_x', datatableKey: 'x', limit: 3 }, w);
    const u = await applyToolCall('builder_update_step', { stepId: r.added.id, patch: { forEach: { overRef: `steps.${listId}.output.items`, itemVar: 'r' } } }, w);
    assert.ok(!u.error, JSON.stringify(u));
    const v = validateDefinition(w.def, { deliverableEvents: [] });
    assert.deepStrictEqual((v.errors || []).filter(e => String(e.code).startsWith('foreach')), []);
});
