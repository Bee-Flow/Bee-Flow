// @typecheck
/**
 * #176: the builder's duplicate-call guard refuses the same tool with the same
 * inputs only when nothing between the two calls changes anything, read off
 * the graph. List a folder, delete a file in it, list it again to check: the
 * second list is a new call. The same list twice in a row stays refused.
 *
 * Run: cd server && node --test automation/builderTools/stepBuilders/toolResolution.duplicate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findDuplicateAction, sideEffectBetween } = require('./toolResolution');
const { applyToolCall, emptyDefinition } = require('../../builderTools');

const STR = { type: 'string' };
const SCHEMAS = {
    nextcloud_list_files: { type: 'object', properties: { path: STR }, required: ['path'] },
    nextcloud_delete: { type: 'object', properties: { path: STR }, required: ['path'] },
    nextcloud_read_file: { type: 'object', properties: { path: STR }, required: ['path'] },
};
const wrap = () => ({
    userId: 'u_test',
    def: emptyDefinition(),
    _inputSchemasByTool: SCHEMAS,
    _inspectedTools: new Set(Object.keys(SCHEMAS)),
    _resultDetail: 'full',
});
const lit = (value) => ({ kind: 'literal', value });
const LIST = { path: lit('/MCP-Test') };

// ── the graph rule, on a hand-built graph ─────────────────────────────────

const list = { id: 'l1', type: 'integration_action', tool: 'nextcloud_list_files', inputs: LIST };
const del = { id: 'd1', type: 'integration_action', tool: 'nextcloud_delete', inputs: { path: lit('/MCP-Test/copy.txt') } };
const read = { id: 'r1', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: lit('/MCP-Test/a.txt') } };
const note = { id: 'n1', type: 'notification', title: 'x' };
const graph = (steps, edges) => ({ trigger: { id: 'trg' }, steps, edges: edges.map(([from, to]) => ({ from, to })) });

test('a write between the existing call and the insertion point: not a duplicate', () => {
    const g = graph([list, del], [['trg', 'l1'], ['l1', 'd1']]);
    assert.equal(sideEffectBetween(g, 'l1', 'd1'), true);
    assert.equal(findDuplicateAction(g, 'nextcloud_list_files', LIST, { anchorId: 'd1' }), null);
});

test('only reads between them, or directly after the call: still a duplicate', () => {
    const g = graph([list, read], [['trg', 'l1'], ['l1', 'r1']]);
    assert.equal(findDuplicateAction(g, 'nextcloud_list_files', LIST, { anchorId: 'r1' })?.id, 'l1');
    assert.equal(findDuplicateAction(g, 'nextcloud_list_files', LIST, { anchorId: 'l1' })?.id, 'l1');
});

test('a sending step (a notification) between them counts as a change too', () => {
    const g = graph([list, note], [['trg', 'l1'], ['l1', 'n1']]);
    assert.equal(findDuplicateAction(g, 'nextcloud_list_files', LIST, { anchorId: 'n1' }), null);
});

test('the graph decides, not the list order: a write on ANOTHER branch is not between them', () => {
    // trg → l1 → r1, and trg → d1 on a branch of its own; the list order puts d1 between.
    const g = graph([list, del, read], [['trg', 'l1'], ['l1', 'r1'], ['trg', 'd1']]);
    assert.equal(findDuplicateAction(g, 'nextcloud_list_files', LIST, { anchorId: 'r1' })?.id, 'l1');
});

test('the existing call runs AFTER the insertion point: a write between them is checked too', () => {
    // New list after trg; existing l1 follows d1.
    const g = graph([del, list], [['trg', 'd1'], ['d1', 'l1']]);
    assert.equal(findDuplicateAction(g, 'nextcloud_list_files', LIST, { anchorId: 'trg' }), null);
    const plain = graph([read, list], [['trg', 'r1'], ['r1', 'l1']]);
    assert.equal(findDuplicateAction(plain, 'nextcloud_list_files', LIST, { anchorId: 'trg' })?.id, 'l1');
});

test('without an insertion point every identical call is a duplicate, as before', () => {
    const g = graph([list, del], [['trg', 'l1'], ['l1', 'd1']]);
    assert.equal(findDuplicateAction(g, 'nextcloud_list_files', LIST)?.id, 'l1');
});

// ── through the builder tools ─────────────────────────────────────────────

test('builder_add_action: list → delete → list again is accepted; list → list is refused', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const first = await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: LIST }, dw);
    assert.ok(!first.error, first.error);

    const twice = await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: LIST }, dw);
    assert.ok(twice.error && /identical inputs/.test(twice.error), twice.error);

    const rm = await applyToolCall('builder_add_action', { tool: 'nextcloud_delete', inputs: { path: lit('/MCP-Test/copy.txt') } }, dw);
    assert.ok(!rm.error, rm.error);
    const again = await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: LIST }, dw);
    assert.ok(!again.error, `a re-read after the delete is a new call: ${again.error}`);
    assert.notEqual(again.added.id, first.added.id);

    // Explicitly anchored right after the first list: nothing between, refused.
    const beside = await applyToolCall('builder_add_action', { tool: 'nextcloud_list_files', inputs: LIST, afterStepId: first.added.id }, dw);
    assert.ok(beside.error && /identical inputs/.test(beside.error), beside.error);
});

test('builder_add_steps: list → delete → list in one batch builds three steps, not two', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const r = await applyToolCall('builder_add_steps', {
        steps: [
            { tempId: 'ls', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: LIST } },
            { tempId: 'rm', type: 'integration_action', spec: { tool: 'nextcloud_delete', inputs: { path: lit('/MCP-Test/copy.txt') } } },
            { tempId: 'ls2', type: 'integration_action', spec: { tool: 'nextcloud_list_files', inputs: LIST } },
        ],
    }, dw);
    assert.ok(!r.error, r.error);
    assert.equal(dw.def.steps.filter(s => s.tool === 'nextcloud_list_files').length, 2);
    assert.notEqual(r.idMap.ls2, r.idMap.ls);
    assert.ok(!r.added.some(a => a.reused), JSON.stringify(r.added));
});
