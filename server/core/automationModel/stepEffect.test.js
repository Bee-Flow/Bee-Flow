// @typecheck
'use strict';
/** stepEffect: the effect of a step from its type and fields (stepEffect.js). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { stepEffect } = require('./stepEffect');

test('stepEffect reads a step by its type and fields, fail-closed on an unknown tool', () => {
    assert.strictEqual(stepEffect({ type: 'set' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'integration_action', tool: 'gmail_search' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'integration_action', tool: 'gmail_compose' }), 'sends');
    assert.strictEqual(stepEffect({ type: 'integration_action', tool: 'no_such_tool' }), 'writes');
    assert.strictEqual(stepEffect({ type: 'integration_action' }), 'writes');
    assert.strictEqual(stepEffect({ type: 'notification' }), 'sends');
    assert.strictEqual(stepEffect({ type: 'http_request' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'http_request', method: 'get' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'http_request', method: 'post' }), 'writes');
    assert.strictEqual(stepEffect({ type: 'code' }), 'writes');
    assert.strictEqual(stepEffect({ type: 'datatable', op: 'find_rows' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'datatable', op: 'update_rows' }), 'writes');
    assert.strictEqual(stepEffect({ type: 'ai_step' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'ai_step', tools: ['gmail_search', 'gmail_compose'] }), 'sends');
    assert.strictEqual(stepEffect(null), 'reads');
});

test('stepEffect looks inside a loop body and a called flowlet, and survives a flowlet that calls itself', () => {
    assert.strictEqual(stepEffect({ type: 'loop', body: [{ type: 'set' }, { type: 'notification' }] }), 'sends');
    assert.strictEqual(stepEffect({ type: 'loop', body: [{ type: 'set' }] }), 'reads');
    const layers = { fl: { steps: [{ type: 'http_request', method: 'DELETE' }] } };
    assert.strictEqual(stepEffect({ type: 'call_layer', layerKey: 'fl' }, { layers }), 'writes');
    assert.strictEqual(stepEffect({ type: 'call_layer', layerKey: 'missing' }, { layers }), 'reads');
    const cyclic = { a: { steps: [{ type: 'call_layer', layerKey: 'a' }] } };
    assert.strictEqual(stepEffect({ type: 'call_layer', layerKey: 'a' }, { layers: cyclic }), 'reads');
});

test('stepEffect covers parallel branches, approval, call_block and an ai_step with implicit tools', () => {
    assert.strictEqual(stepEffect({ type: 'parallel', branches: [[{ type: 'set' }], [{ type: 'set' }, { type: 'notification' }]] }), 'sends');
    assert.strictEqual(stepEffect({ type: 'parallel', branches: [[{ type: 'code' }], [{ type: 'set' }]] }), 'writes');
    assert.strictEqual(stepEffect({ type: 'parallel', branches: [[{ type: 'set' }]] }), 'reads');
    assert.strictEqual(stepEffect({ type: 'parallel' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'parallel', branches: ['junk', null] }), 'reads');
    assert.strictEqual(stepEffect({ type: 'approval' }), 'sends');
    assert.strictEqual(stepEffect({ type: 'call_block', blockId: 'b1' }), 'writes');
    assert.strictEqual(stepEffect({ type: 'ai_step', allowTools: true }), 'writes');
    assert.strictEqual(stepEffect({ type: 'ai_step', allowTools: false }), 'reads');
    assert.strictEqual(stepEffect({ type: 'ai_step', agentId: 'agt_1' }), 'writes');
    assert.strictEqual(stepEffect({ type: 'ai_step', agentId: '  ' }), 'reads');
    // An explicit allow-list still decides on its own.
    assert.strictEqual(stepEffect({ type: 'ai_step', allowTools: true, tools: ['gmail_search'] }), 'reads');
});

test('the table steps only read: they open and reshape data inside the run', () => {
    assert.strictEqual(stepEffect({ type: 'read_table' }), 'reads');
    assert.strictEqual(stepEffect({ type: 'table', ops: [{ op: 'pseudonymise' }, { op: 'group' }] }), 'reads');
    assert.strictEqual(stepEffect({ type: 'loop', body: [{ type: 'read_table' }, { type: 'table' }] }), 'reads');
    assert.strictEqual(stepEffect({ type: 'loop', body: [{ type: 'table' }, { type: 'notification' }] }), 'sends');
});
