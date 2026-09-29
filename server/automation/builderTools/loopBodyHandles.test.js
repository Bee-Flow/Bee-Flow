/**
 * builder_add_loop — `steps.$handle` inside a body resolves at add time.
 *
 * REGRESSION (2026-09-11): the model learns `steps.$read` from the batch tool
 * and carries it into loop bodies. The loop tool stored it verbatim, minted
 * the body step as `lb_…`, and the validator reported ref.unknown_step one
 * round later on an id the model had never seen. Every loop in one measured
 * build cost a repair round this way (three loops, three rounds).
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/loopBodyHandles.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { applyToolCall, emptyDefinition } = require('../builderTools');
const { validateDefinition } = require('../validate');

const wrap = () => ({ userId: 'u_test', def: emptyDefinition() });

test('a body step with tempId becomes that id, and a later $ref to it resolves', async () => {
    const dw = wrap();
    const r = await applyToolCall('builder_add_loop', {
        overRef: 'trigger.output.items', itemVar: 'item',
        body: [
            { tempId: 'read', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: { kind: 'ref', path: 'loop.item.path' } } },
            { type: 'ai_step', prompt: 'Extract', inputs: { content: { kind: 'ref', path: 'steps.$read.output.content' } } },
        ],
    }, dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.added.body[0].id, 'read');
    assert.ok(!('tempId' in r.added.body[0]), 'tempId does not leak onto the stored step');
    assert.strictEqual(r.added.body[1].inputs.content.path, 'steps.read.output.content');
    const v = validateDefinition(dw.def);
    assert.ok(!v.errors.some(e => e.code === 'ref.unknown_step'), JSON.stringify(v.errors));
});

test('an explicit id works as the handle too, with or without the $', async () => {
    const dw = wrap();
    const r = await applyToolCall('builder_add_loop', {
        overRef: 'trigger.output.items', itemVar: 'item',
        body: [
            { id: 'read', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: { kind: 'ref', path: 'loop.item.path' } } },
            { type: 'ai_step', prompt: 'A', inputs: { a: { kind: 'ref', path: 'steps.$read.output.content' } } },
            { type: 'ai_step', prompt: 'B', inputs: { b: { kind: 'ref', path: 'steps.read.output.content' } } },
        ],
    }, dw);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.added.body[1].inputs.a.path, 'steps.read.output.content');
    assert.strictEqual(r.added.body[2].inputs.b.path, 'steps.read.output.content');
});

test('the exact measured failure — $read with no id on the read step — is refused with the fix spelled out', async () => {
    const dw = wrap();
    const r = await applyToolCall('builder_add_loop', {
        overRef: 'trigger.output.items', itemVar: 'item',
        body: [
            { type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: { kind: 'ref', path: 'loop.item.path' } } },
            { type: 'ai_step', prompt: 'Extract', inputs: { content: { kind: 'ref', path: 'steps.$read.output.content' } } },
        ],
    }, dw);
    assert.ok(r.error, 'must be refused at the call that caused it');
    assert.match(r.error, /"id":"read"/);
    assert.strictEqual(dw.def.steps.length, 0, 'nothing was added');
});

test('a handle declared LATER in the body is a reorder problem, and the error says so', async () => {
    const dw = wrap();
    const r = await applyToolCall('builder_add_loop', {
        overRef: 'trigger.output.items', itemVar: 'item',
        body: [
            { type: 'ai_step', prompt: 'Extract', inputs: { content: { kind: 'ref', path: 'steps.$read.output.content' } } },
            { id: 'read', type: 'integration_action', tool: 'nextcloud_read_file', inputs: { path: { kind: 'ref', path: 'loop.item.path' } } },
        ],
    }, dw);
    assert.match(r.error, /LATER/);
});

test('a body id that collides with an existing step is refused', async () => {
    const dw = wrap();
    const a = (await applyToolCall('builder_add_notification', { title: 'a' }, dw)).added;
    const r = await applyToolCall('builder_add_loop', {
        overRef: 'trigger.output.items', itemVar: 'item',
        body: [{ id: a.id, type: 'notification', title: 'x' }],
    }, dw);
    assert.match(r.error, /already used/);
});

test('body steps without any handle still get lb_ ids, as before', async () => {
    const dw = wrap();
    const r = await applyToolCall('builder_add_loop', {
        overRef: 'trigger.output.items', itemVar: 'item',
        body: [{ type: 'notification', title: '{{loop.item.name}}' }],
    }, dw);
    assert.ok(!r.error, r.error);
    assert.match(r.added.body[0].id, /^lb_/);
});
