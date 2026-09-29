'use strict';

/**
 * App Studio builder tools — a recorded turn, replayed.
 *
 * `traces/<date>-<name>.json` is ONE builder turn a real model produced, its
 * tool calls verbatim in order (`calls[].args`) with what the server answered
 * AT THE TIME (`observed` — history, not an expectation). The routine builder's
 * corpus is one call per file because its calls are independent; here the
 * loop IS the sequence: a duplicate batch is only a duplicate after the first
 * one landed, a plan resend only a resend after the plan was set. So the whole
 * turn replays against today's code, twice — once as it happened (no tables:
 * every refusal must now say what to do) and once with the tables the model
 * meant to create (every shape must now land as the canonical action).
 *
 * Fixture shape: { name, recordedAt, model, brief, note, calls:[{ n, tool,
 * args, shape?, observed }] }. Add a call by copying the arguments off the
 * transcript; never edit an existing call's args.
 *
 * Run: node --test --test-force-exit appStudio/builderTools/traces.replay.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { applyToolCall } = require('../builderTools');
const { emptyDefinition } = require('../componentSpecs');
const { mergeTableOp } = require('./dataTools');
const { canonicalizeDataModel, emptyDataModel } = require('../dataModel');
const { mergePlanTodos, planEcho } = require('../../core/llm/planChecklist');

const TRACE = JSON.parse(fs.readFileSync(path.join(__dirname, 'traces', '2026-09-13-invoice-tracker.json'), 'utf8'));
const call = (n) => TRACE.calls.find((c) => c.n === n);

function wrapWith(model) {
    return { userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_trace', def: emptyDefinition('Invoice Tracker'), dataModel: model, dataModelVersion: 0, rowCounts: {}, datasetIds: [] };
}

/** The two tables the model meant, created the way it should have (pure merge). */
function modelWithTables() {
    let model = emptyDataModel();
    for (const args of [
        { name: 'Suppliers', fields: [{ key: 'name', type: 'text' }, { key: 'email', type: 'text' }, { key: 'category', type: 'select', options: ['utilities', 'hardware', 'software', 'services'] }] },
        { name: 'Invoices', fields: [{ key: 'supplier_id', type: 'text' }, { key: 'invoice_no', type: 'text' }, { key: 'amount', type: 'number' }, { key: 'due_date', type: 'date' }] },
    ]) {
        const merged = mergeTableOp(model, args, {});
        assert.ok(!merged.error, JSON.stringify(merged));
        model = canonicalizeDataModel(merged.model).model;
    }
    return model;
}

async function setUp(wrap) {
    for (const n of [1, 2]) {
        const r = await applyToolCall(call(n).tool, call(n).args, wrap);
        assert.ok(!r.error, `${call(n).tool}: ${JSON.stringify(r)}`);
    }
    return wrap.def.screens.find((s) => s.name === 'Suppliers').sections[0].id;
}

test(`${TRACE.name}: with NO tables (as it happened) every set_action shape is refused with a reason that names both creators; the corrupted one is called corrupted`, async () => {
    const wrap = wrapWith(null);
    await setUp(wrap);
    for (const shape of ['a', 'c', 'd']) {
        const c = TRACE.calls.find((x) => x.shape === shape);
        const r = await applyToolCall('app_set_action', c.args, wrap);
        assert.ok(r.error, `shape ${shape} must still be refused without tables`);
        assert.match(r._fixHint, /\[0\] Reject reason: table "tbl_(invoices|suppliers)_01" is not in the app \(it has no tables yet\)/, `shape ${shape}: ${r._fixHint}`);
        assert.match(r._fixHint, /app_upsert_table \{name, fields:\[\{key,type\}\]\}/);
        assert.match(r._fixHint, /app_link_datatable \{name\}/);
        assert.ok(!r._suggestedPatch, `shape ${shape}: nothing to patch when the table does not exist`);
        assert.strictEqual(r.failed.length, 2);
        // The repairs already made are said, so the model does not redo them.
        if (shape === 'a') assert.ok(r.failed[0]._hints.some((h) => /"inputMapping" read as "values"/.test(h)), JSON.stringify(r.failed[0]._hints));
        if (shape === 'c') assert.ok(r.failed[0]._hints.some((h) => /kind:"field", name:"category"\} read as/.test(h)));
        if (shape === 'd') assert.ok(r.failed[0]._hints.some((h) => /forms\.supplier_form\.category" read as "form\.category"/.test(h)));
        assert.strictEqual(Object.keys(wrap.def.actions || {}).length, 0, 'nothing created');
    }
    // The corrupted batch (two values that arrived as binding-JSON strings):
    // since 2026-09-14 the strings are PARSED back into their bindings (the
    // patch the tool used to suggest, applied), so here — with no tables —
    // the refusal is about the missing table, and the values are already
    // form.<name>; with the tables it lands (next test).
    const b = await applyToolCall('app_set_action', call(5).args, wrap);
    assert.match(b.error, /All 2 action\(s\) failed/);
    assert.match(b._fixHint, /\[0\] Reject reason: table "tbl_(invoices|suppliers)_01" is not in the app/);
    assert.ok(b.failed[0]._hints.some((h) => /action\.values\.category arrived as a string carrying binding JSON — read as the binding \{kind:"field"/.test(h)), JSON.stringify(b.failed[0]._hints));
    assert.ok(b.failed[1]._hints.some((h) => /action\.values\.amount arrived as a string carrying binding JSON/.test(h)), JSON.stringify(b.failed[1]._hints));
});

test(`${TRACE.name}: with the tables it meant, shapes (a)(c)(d) land as the canonical sequence; the second identical batch is a twin refusal with the specific hint`, async () => {
    const shapes = { a: call(4), c: call(6), d: call(7) };
    for (const [shape, c] of Object.entries(shapes)) {
        const wrap = wrapWith(modelWithTables());
        await setUp(wrap);
        const [suppliers, invoices] = [wrap.dataModel.tables.find((t) => t.key === 'suppliers'), wrap.dataModel.tables.find((t) => t.key === 'invoices')];
        const r = await applyToolCall('app_set_action', c.args, wrap);
        assert.ok(!r.error, `shape ${shape}: ${JSON.stringify(r)}`);
        assert.strictEqual(r.applied, 2);
        assert.strictEqual(r.actionId.length, 2);
        const actions = r.actionId.map((id) => wrap.def.actions[id]);
        // Every table id resolved to the real table, every value to form.<name>.
        for (const a of actions) {
            const step = a.kind === 'sequence' ? a.steps[0] : a;
            assert.strictEqual(step.kind, 'create_record');
            assert.ok([suppliers.id, invoices.id].includes(step.tableId), `${shape}: ${step.tableId}`);
            for (const [k, v] of Object.entries(step.values)) assert.deepStrictEqual(v, { kind: 'formula', expr: `form.${k}` }, `${shape}: values.${k}`);
        }
        if (shape === 'a') {
            // The effects became the steps that follow, with the refresh.
            assert.deepStrictEqual(actions[0].steps.map((s) => s.kind), ['create_record', 'refresh', 'toast']);
            assert.strictEqual(actions[0].steps[1].tableId, invoices.id);
            assert.strictEqual(actions[0].steps[2].message, 'Invoice registered!');
        } else {
            assert.ok(actions.every((a) => a.kind === 'create_record'), 'no effects → not wrapped');
        }
        assert.ok(r._hints.some((h) => /\[[01]\] .*"tbl_(invoices|suppliers)_01" is not a table — read as tbl_/.test(h)), JSON.stringify(r._hints));
        // The exact same batch again: two twin refusals, each with the reason.
        const again = await applyToolCall('app_set_action', c.args, wrap);
        assert.ok(again.error);
        assert.match(again._fixHint, /\[0\] Reject reason: duplicate action — "act_[a-z0-9]+" already has exactly this definition/);
        assert.strictEqual(Object.keys(wrap.def.actions).length, 2, 'no third or fourth action');
    }
});

test(`${TRACE.name}: the components batch lands once — titled containers as cards, options inside props — and its three resends are refused with the first send's ids`, async () => {
    const wrap = wrapWith(modelWithTables());
    const sectionId = await setUp(wrap);
    const suppliers = wrap.dataModel.tables.find((t) => t.key === 'suppliers');
    const withParent = (c) => ({ ...c.args, parentId: sectionId });

    const first = await applyToolCall('app_add_components', withParent(call(8)), wrap);
    assert.ok(!first.error, JSON.stringify(first));
    assert.strictEqual(first.added.length, 12);
    assert.deepStrictEqual(first.added.filter((a) => a.type === 'card').length, 2, 'both titled containers landed as cards');
    assert.strictEqual(first.added.filter((a) => a.type === 'container').length, 0);
    assert.deepStrictEqual(Object.keys(first.ids), ['sup_form', 'inv_form']);
    assert.ok(first._hints.some((h) => /container with a title read as card \(container has no title; look panel → default\)/.test(h)), JSON.stringify(first._hints));
    assert.ok(first._hints.some((h) => /"options" was placed next to props/.test(h)));
    assert.ok(!first._hints.some((h) => /Dropped unknown prop keys: title/.test(h)), 'the title is kept, not dropped');
    // The relation input's invented table id was repaired to the real table.
    const relation = first.added.find((a) => a.type === 'input_relation');
    const { findNode } = require('../definitionOps');
    assert.strictEqual(findNode(wrap.def, relation.id).node.props.tableId, suppliers.id);
    assert.ok(first._hints.some((h) => /props\.tableId "tbl_suppliers_01" is not a table — read as tbl_/.test(h)));
    const cardTitle = findNode(wrap.def, first.added[0].id).node.props.title;
    assert.strictEqual(cardTitle, 'Add New Supplier');

    const before = JSON.stringify(wrap.def);
    for (const [i, n] of [9, 11, 12, 13].entries()) {
        const dup = await applyToolCall('app_add_components', withParent(call(n)), wrap);
        assert.ok(dup.error, `send ${n} must be refused`);
        assert.match(dup.error, /^Nothing new: (this exact batch already landed this turn|the form\(s\) in this batch already exist on this screen) under sec_/);
        assert.deepStrictEqual(Object.values(dup.alreadyAdded.ids).sort(), Object.values(first.ids).sort(), 'the ids of the first send, whatever the tempIds now are');
        assert.strictEqual(dup._repeated, i + 1);
        assert.match(dup._fixHint, /^Reject reason: duplicate batch — /);
        assert.match(dup._fixHint, new RegExp(`nodeId:"${first.ids.sup_form}"`));
        if (call(n).args.type) assert.ok(dup._hints.some((h) => /^root keys [a-z, ]+ ignored — component entries belong in components\[\]/.test(h) && /type/.test(h)), `send ${n}: ${JSON.stringify(dup._hints)}`);
    }
    assert.strictEqual(JSON.stringify(wrap.def), before, 'the draft did not change');
    assert.strictEqual(wrap.def.screens.find((s) => s.id === findNode(wrap.def, first.added[0].id).screen.id).sections[0].children.length, 2, 'exactly one copy of the two cards');
});

test(`${TRACE.name}: without tables the relation input is refused at add time, naming both creators`, async () => {
    const wrap = wrapWith(null);
    const sectionId = await setUp(wrap);
    const r = await applyToolCall('app_add_components', { ...call(8).args, parentId: sectionId }, wrap);
    assert.ok(r.error, JSON.stringify(r).slice(0, 300));
    assert.match(r.error, /input_relation names table "tbl_suppliers_01", which this app does not have/);
    assert.match(r._fixHint, /^Reject reason: input_relation names table "tbl_suppliers_01"/);
    assert.match(r._fixHint, /app_upsert_table \{name, fields:\[\{key,type\}\]\}/);
    assert.match(r._fixHint, /app_link_datatable \{name\}/);
    assert.strictEqual(wrap.def.screens.find((s) => s.name === 'Suppliers').sections[0].children.length, 0, 'nothing landed');
});

test(`${TRACE.name}: the plan resend keeps what was ticked and says so`, () => {
    const first = mergePlanTodos([], call(3).args.todos);
    assert.strictEqual(first.unchanged, false);
    const ticked = first.todos.map((t, i) => ({ ...t, done: i < 2 }));
    const again = mergePlanTodos(ticked, call(10).args.todos);
    assert.strictEqual(again.unchanged, true);
    assert.deepStrictEqual(again.todos, ticked);
    assert.strictEqual(planEcho(again.todos).next, 'Build Supplier management screen');
});
