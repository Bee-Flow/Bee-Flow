// @typecheck
'use strict';

/**
 * Characterisation (golden) test for the one-line tool summaries of the App
 * Studio builder: every tool in TOOL_LABELS (and an unknown one) against the
 * result shapes it can meet: nothing, an empty object, an error, a
 * non-object, its own full result, its batch form and the variants that flip
 * each optional part of the line (plural, note, truncated, fallbacks to the
 * arguments). The same line must come out of toolCallEvent().
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test usecases/ai/appStudioBuilder/toolCallEvents.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { TOOL_LABELS, summariseToolResult, toolCallEvent } = require('./toolCallEvents');

const GOLDEN = path.join(__dirname, 'toolCallEvents.characterisation.golden.json');
const LONG = `${'long  text\n'.repeat(20)}end`;

/** Shapes every tool meets. @type {Array<[any, any]>} */
const COMMON = [
    [null, null],
    [undefined, undefined],
    [{}, {}],
    [{}, { error: 'Screen  not\nfound' }],
    [{}, { error: LONG, _fixHint: 'retry' }],
    [{ name: 'From args', screenId: 's_args', tableId: 't_args', automationId: 'a_args', templateId: 'tpl_args' }, {}],
    [{}, 'a string result'],
    [{}, { batch: true, applied: 3 }],
    [{}, { error: 'e'.repeat(140) }],
    [{}, { error: 'e'.repeat(141) }],
];

/** The shapes of each tool's own result. @type {Record<string, Array<[any, any]>>} */
const OWN = {
    app_set_meta: [[{ name: 'Arg name' }, { meta: { name: 'Result name' } }], [{ name: 'Arg name' }, { meta: {} }], [{}, { meta: { name: LONG } }]],
    app_set_theme: [[{ theme: {} }, { ok: true }]],
    app_add_screen: [[{ name: 'Home' }, { screenId: 'scr_1' }], [{}, { screenId: 'scr_2' }]],
    app_update_screen: [[{ screenId: 'scr_1' }, { ok: true }]],
    app_remove_screen: [[{ screenId: 'scr_1' }, { removed: 'scr_1' }]],
    app_add_section: [[{}, { sectionId: 'sec_1' }]],
    app_update_section: [[{}, { sectionId: 'sec_1' }]],
    app_add_components: [[{}, { added: [{ id: 'n1' }, { id: 'n2' }] }], [{}, { added: 'nope' }], [{}, { added: [] }]],
    app_update_component: [[{ nodeId: 'n1' }, { updated: 'n1' }], [{}, { batch: true, applied: 0 }], [{}, { batch: false, applied: 4, updated: 'n9' }]],
    app_move_node: [[{}, { moved: 'n1', toParentId: 'sec_2' }], [{}, { moved: 'n1' }]],
    app_remove_node: [[{}, { removed: 'n1' }]],
    app_set_action: [
        [{ action: { kind: 'sequence' } }, { created: true, actionId: 'act_1' }],
        [{ action: { kind: 'navigate' } }, { created: false, actionId: 'act_1' }],
        [{ action: {} }, { actionId: 'act_2' }],
        [{}, { actionId: 'act_3' }],
        [{ action: { kind: 'sequence' } }, { batch: true, applied: 2, actionId: 'act_1' }],
    ],
    app_remove_action: [[{}, { removed: 'act_1' }]],
    app_bind_action: [
        [{ actionId: 'act_1', event: 'onClick', nodeId: 'n1' }, { actionId: 'act_1' }],
        [{ actionId: null, event: 'onClick', nodeId: 'n1' }, { actionId: 'act_9' }],
        [{ event: 'onSubmit' }, {}],
        [{ actionId: null }, { batch: true, applied: 5 }],
        [{ actionId: null, event: 'onClick', nodeId: 'n1' }, null],
    ],
    app_get_draft: [[{}, { def: {} }]],
    app_get_node: [[{}, { nodes: [{}, {}, {}] }], [{}, { nodes: {} }]],
    app_find_nodes: [[{}, { hitCount: 7 }], [{}, { hitCount: 0, truncated: true }], [{}, { hitCount: 40, truncated: true }], [{}, { hitCount: null }]],
    app_inspect_catalog: [[{}, { catalog: [] }]],
    app_list_automations: [[{}, { automations: [{}, {}] }], [{}, { automations: 'x' }]],
    app_inspect_automation: [[{ automationId: 'auto_1' }, { automation: { title: 'Invoice run' } }], [{ automationId: 'auto_1' }, { automation: {} }], [{ automationId: 'auto_1' }, {}]],
    app_upsert_table: [
        [{}, { key: 'orders', tableId: 'tbl_1', fields: [{}, {}], migration: 'created' }],
        [{}, { key: 'orders', tableId: 'tbl_1', fields: 'x' }],
        [{}, { key: 'orders', tableId: 'tbl_1', fields: [], migration: '' }],
    ],
    app_link_datatable: [
        [{}, { table: { id: 'tbl_1', name: 'Orders', key: 'orders', linked: { kind: 'nextcloud', mode: 'read', rowCount: 1 } } }],
        [{}, { table: { id: 'tbl_1', key: 'orders', linked: { kind: 'studio', mode: 'write', rowCount: 12 } }, note: 'two columns skipped' }],
        [{}, { table: { linked: { rowCount: 0 } } }],
        [{}, { table: { name: 'Orders', linked: { kind: 'nextcloud', rowCount: '3' } } }],
        [{}, { table: { id: 'tbl_2', linked: { mode: 'read', rowCount: NaN } } }],
        [{}, { table: null, note: 'nothing linked' }],
    ],
    app_set_plan: [
        [{}, { todos: [{ done: true }, { done: false }, null, { done: 1 }], next: 'Build the list screen' }],
        [{}, { todos: [{ done: true }] }],
        [{}, { todos: [] }],
        [{}, { todos: 'x', next: 'ignored' }],
    ],
    app_remove_table: [[{}, { removed: 'tbl_1' }], [{}, { removed: 'tbl_1', note: '3 bindings cleared' }]],
    app_set_roles: [[{}, { roles: ['admin', 'viewer'] }], [{}, { roles: [] }], [{}, { roles: 'admin' }]],
    app_seed_records: [
        [{ tableId: 'tbl_arg' }, { inserted: 5, tableId: 'tbl_1' }],
        [{ tableId: 'tbl_arg' }, { inserted: 0, failed: [{}, {}] }],
        [{ tableId: 'tbl_arg' }, { failed: [] }],
        [{}, { inserted: null, failed: 'x' }],
    ],
    app_upsert_dataset: [[{}, { name: 'Open orders', datasetId: 'ds_1', rowCount: 9 }], [{}, { name: 'Open orders', datasetId: 'ds_1' }]],
    app_get_data_model: [[{}, { tables: [] }]],
    app_query_data: [[{}, { rowCount: 20, more: true }], [{}, { rowCount: 1 }], [{}, { more: true }]],
    app_list_connectors: [[{}, { connectors: [{}] }], [{}, { connectors: null }]],
    app_list_assets: [[{}, { assets: [{}, {}, {}, {}] }], [{}, { assets: 4 }]],
    app_dry_run: [
        [{}, { ok: true }],
        [{}, { ok: true, emptyTables: [{}] }],
        [{}, { ok: true, emptyTables: [{}, {}] }],
        [{}, { ok: false, static: { errors: [{}] } }],
        [{}, { ok: false, static: { errors: [{}, {}] }, emptyTables: [{}] }],
        [{}, { static: { errors: 'x' }, emptyTables: [{}, {}, {}] }],
        [{}, { ok: true, static: { errors: [{}] }, emptyTables: 'x' }],
    ],
    app_screenshot: [
        [{}, { _screenshotDataUrl: 'data:image/png;base64,AAAA', _screenshotCaption: 'Home on mobile', content: 'never shown' }],
        [{}, { _screenshotDataUrl: 'data:image/png;base64,AAAA', content: 'never shown' }],
        [{}, { content: 'Could   not render\nthe screen' }],
        [{}, { _screenshotCaption: 'caption without a picture' }],
    ],
    app_propose_plan: [[{}, { planId: 'plan_1' }], [{}, { ok: true }]],
    app_ask_questions: [[{}, { questions: [] }]],
    app_mark_phase: [[{}, { index: 2, label: 'Data model' }], [{}, { index: 0 }], [{}, { label: 'Screens' }], [{}, { index: null, label: LONG }]],
    app_list_templates: [[{}, { templates: [{}, {}] }], [{}, { templates: {} }]],
    app_apply_template: [[{ templateId: 'tpl_arg' }, { templateId: 'tpl_1' }], [{ templateId: 'tpl_arg' }, { ok: true }], [{}, { ok: true }]],
    app_finalize: [[{}, { finalized: true, name: 'Order desk' }], [{}, { finalized: true }], [{}, { finalized: false, name: 'Order desk' }], [{}, { finalized: true, name: LONG }]],
    not_a_tool: [[{ name: 'x' }, { ok: true }]],
};

function runAll() {
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const name of [...Object.keys(TOOL_LABELS), 'not_a_tool']) {
        out[name] = [...COMMON, ...(OWN[name] || [])].map(([args, result]) => summariseToolResult(name, args, result));
    }
    return out;
}

test('every tool label has its own result shapes in this table', () => {
    assert.deepEqual(Object.keys(TOOL_LABELS).filter((name) => !OWN[name]), []);
});

test('summariseToolResult: one line per tool and result shape (golden)', () => {
    const actual = runAll();
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});

test('toolCallEvent carries the same line as its summary', () => {
    for (const name of [...Object.keys(TOOL_LABELS), 'not_a_tool']) {
        for (const [args, result] of [...COMMON, ...(OWN[name] || [])]) {
            assert.equal(toolCallEvent(name, args, result, true, null).summary, summariseToolResult(name, args, result));
        }
    }
});
