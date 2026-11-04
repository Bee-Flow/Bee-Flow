/**
 * app_upsert_table on a table that holds rows (dataToolsTables.js): the safe
 * type conversions save with the conversion on, dryRun persists nothing, the
 * save's own refusals are worded with a fix, and app_get_data_model shows how a
 * computed field is kept. The data store's functions are stubs;
 * the planner and the report builder are the real ones.
 *
 * Run: cd server && node --test appStudio/builderTools/dataToolsTables.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const clone = (v) => JSON.parse(JSON.stringify(v));
const state = { meta: null, saveCalls: [], previewCalls: [], previewProbed: [], nextSave: null };

const stubDataStore = {
    async getDataModel() { return state.meta ? { model: clone(state.meta.model), modelVersion: state.meta.version } : null; },
    async saveDataModel(appId, ownerId, model, { expectedVersion = null, ...saveOpts } = {}) {
        state.saveCalls.push({ expectedVersion, saveOpts });
        if (state.nextSave) { const r = state.nextSave; state.nextSave = null; return r; }
        const version = (state.meta ? state.meta.version : 0) + 1;
        state.meta = { model: clone(model), version };
        return { ok: true, version };
    },
    async previewDataModelChange(appId, ownerId, model, opts = {}) {
        state.previewCalls.push(opts);
        const { buildMigrationReport } = require('../../stores/studioAppData/migrationPreview.mts');
        const { planMigration, emptyDataModel } = require('../dataModel');
        const plan = planMigration(state.meta ? state.meta.model : emptyDataModel(), model, { convertTypes: true, onUnconvertible: opts.onUnconvertible });
        return { ok: true, dryRun: true, currentVersion: state.meta ? state.meta.version : 0, report: buildMigrationReport(plan, state.previewProbed) };
    },
    async getRowCounts() { return {}; },
};
// The tools reach the store through require() at call time, so the stub is
// laid over the real module's exports (no module-system mock).
const realStore = Object.assign(require('../../stores/studioAppDataStore'), stubDataStore);

const { applyUpsertTable } = require('./dataToolsTables');
const { renderDataBlock } = require('../builderPrompt');

function reset() {
    Object.assign(state, { meta: null, saveCalls: [], previewCalls: [], previewProbed: [], nextSave: null });
    return { userId: 'u1', appId: 'app_1', dataModel: null, dataModelVersion: 0, rowCounts: {}, datasetIds: [] };
}

async function tasks(wrap, statusType = 'text') {
    const r = await applyUpsertTable(wrap, { key: 'tasks', name: 'Tasks', fields: [{ key: 'title', type: 'text' }, { key: 'status', type: statusType }] });
    assert.ok(!r.error, JSON.stringify(r));
    return r;
}

test('a safe pair (text → number) saves with the conversion on and says so', async () => {
    const wrap = reset();
    const first = await tasks(wrap);
    const r = await applyUpsertTable(wrap, { tableId: first.tableId, fields: [{ key: 'title', type: 'text' }, { key: 'status', type: 'number' }] });
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(state.saveCalls.at(-1).saveOpts, { convertTypes: true, onUnconvertible: 'refuse' });
    assert.ok(r._hints.some((h) => /converts text → number on save/.test(h)));
    assert.strictEqual(wrap.dataModel.tables[0].fields[1].type, 'number');
});

test('integer → number: subtype null clears the inherited integer', async () => {
    const wrap = reset();
    const first = await applyUpsertTable(wrap, { key: 'lines', name: 'Lines', fields: [{ key: 'qty', type: 'number', subtype: 'integer' }] });
    const kept = await applyUpsertTable(wrap, { tableId: first.tableId, fields: [{ key: 'qty', type: 'number' }] });
    assert.strictEqual(wrap.dataModel.tables[0].fields[0].subtype, 'integer', 'leaving subtype out keeps it');
    assert.ok(!(kept._hints || []).some((h) => /converts/.test(h)));
    const r = await applyUpsertTable(wrap, { tableId: first.tableId, fields: [{ key: 'qty', type: 'number', subtype: null }] });
    assert.ok(r._hints.some((h) => /converts integer → number/.test(h)), JSON.stringify(r));
    assert.strictEqual(wrap.dataModel.tables[0].fields[0].subtype, undefined);
});

test('dryRun answers the conversion counts and persists nothing', async () => {
    const wrap = reset();
    const first = await tasks(wrap);
    const saves = state.saveCalls.length;
    state.previewProbed = [{ opIndex: 0, n: 7, bad: 2, samples: ['later', 'weird'] }];
    const r = await applyUpsertTable(wrap, {
        tableId: first.tableId, dryRun: true,
        fields: [{ key: 'title', type: 'text' }, { key: 'status', type: 'select', options: ['todo', 'done'] }],
    });
    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.saved, false);
    assert.deepStrictEqual(r.converted.map((c) => [c.field, c.from, c.to, c.unconvertible, c.samples]), [['status', 'text', 'select', 2, ['later', 'weird']]]);
    assert.match(r._fixHint, /onUnconvertible:"clear"/);
    assert.strictEqual(state.saveCalls.length, saves, 'a dry run saves nothing');
    assert.strictEqual(wrap.dataModelVersion, 1, 'the draft keeps its version');
    assert.strictEqual(wrap.dataModel.tables[0].fields[1].type, 'text', 'the draft keeps its model');
});

test('a refused conversion names onUnconvertible; a failed recompute is a fixed sentence; clear is passed on', async () => {
    const wrap = reset();
    const first = await tasks(wrap);
    const toSelect = { tableId: first.tableId, fields: [{ key: 'title', type: 'text' }, { key: 'status', type: 'select', options: ['todo'] }] };
    state.nextSave = { ok: false, conversionRefused: true, conversions: [{ table: 'tasks', field: 'status', from: 'text', to: 'select', rows: 4, unconvertible: 3, action: 'refuse' }] };
    const refused = await applyUpsertTable(wrap, toSelect);
    assert.match(refused.error, /3 value\(s\) in tasks\.status cannot convert from text to select/);
    assert.match(refused._fixHint, /onUnconvertible:"clear"/);
    assert.strictEqual(wrap.dataModel.tables[0].fields[1].type, 'text', 'nothing adopted');

    state.nextSave = { ok: false, migrationFailed: true, failure: { kind: 'recompute', table: 'tasks', field: 'total', reason: 'division_by_zero', message: 'The expression divides by zero for at least one row.' } };
    const failed = await applyUpsertTable(wrap, toSelect);
    assert.match(failed.error, /tasks\.total could not be recomputed\. The expression divides by zero/);
    assert.match(failed._fixHint, /NULLIF/);

    const cleared = await applyUpsertTable(wrap, { ...toSelect, onUnconvertible: 'clear' });
    assert.ok(!cleared.error, JSON.stringify(cleared));
    assert.deepStrictEqual(state.saveCalls.at(-1).saveOpts, { convertTypes: true, onUnconvertible: 'clear' });
});

test('a database error never reaches the caller verbatim; a store refusal (4xx) does', async () => {
    const wrap = reset();
    const first = await tasks(wrap);
    const original = realStore.saveDataModel;
    realStore.saveDataModel = async () => { throw Object.assign(new Error('value "secret row" violates check'), { code: '23514' }); };
    const hidden = await applyUpsertTable(wrap, { tableId: first.tableId, fields: [{ key: 'title', type: 'text' }] });
    assert.doesNotMatch(hidden.error, /secret row/);
    realStore.saveDataModel = async () => { throw Object.assign(new Error('This data model change is not additive'), { status: 409 }); };
    const shown = await applyUpsertTable(wrap, { tableId: first.tableId, fields: [{ key: 'title', type: 'text' }] });
    assert.match(shown.error, /not additive/);
    realStore.saveDataModel = original;
});

test('app_get_data_model shows whether a computed field is stored and its expr; the per-turn block does not', async () => {
    const wrap = reset();
    const r = await applyUpsertTable(wrap, {
        key: 'lines', name: 'Lines',
        fields: [
            { key: 'qty', type: 'number' },
            { key: 'dbl', type: 'computed', computed: { expr: 'qty * 2', type: 'number', stored: true } },
            { key: 'label', type: 'computed', computed: { expr: "'x'" } },
        ],
    });
    assert.ok(r._hints.some((h) => /"label" is a read-time computed field: it is not evaluated yet/.test(h)));
    const withIds = renderDataBlock(wrap.dataModel, [], {}, null, { fieldIds: true });
    assert.match(withIds, /dbl computed id=fld_[a-z0-9]+ \(read-only\) stored returns=number expr="qty \* 2"/);
    assert.match(withIds, /label computed id=fld_[a-z0-9]+ \(read-only\) read-time \(not evaluated\) expr="'x'"/);
    const perTurn = renderDataBlock(wrap.dataModel, [], {});
    assert.match(perTurn, /^ {4}dbl computed \(read-only\)$/m, 'the per-turn block is unchanged');
    assert.match(perTurn, /^ {4}label computed \(read-only\)$/m);
});
