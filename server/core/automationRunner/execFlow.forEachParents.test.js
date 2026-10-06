/**
 * A "run once per item" step over a list INSIDE a list keeps the outer item
 * (`forEach.parents`), a path that matches nothing is never a green zero-run
 * pass, and a failed item keeps its place in the result columns.
 *
 * Run: cd server && node --test core/automationRunner/execFlow.forEachParents.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { execForEachStep } = require('./execFlow');
const { walkPath } = require('../../automation/bind');
const { resolveForEachItems, walkWithTrail } = require('./forEachScope');
const { parsePath } = require('../../automation/expr');

// Shopify-like: orders → line items → properties. Parent and child both have `id`.
const SHOP = {
    orders: [
        { id: 1001, name: '#1001', line_items: [
            { id: 9001, sku: 'TSHIRT-M', properties: [{ name: 'Engraving', value: 'Tom' }] },
            { id: 9002, sku: 'MUG', properties: [{ name: 'Gift', value: 'yes' }] },
        ] },
        { id: 1002, name: '#1002', line_items: [{ id: 9003, sku: 'CAP', properties: [{ name: 'Color', value: 'Red' }] }] },
        { id: 1003, name: '#1003', line_items: [] },
    ],
};
// Gmail read run per search result: the forEach envelope.
const READ = {
    iterations: 2, succeeded: 2, failed: 0,
    results: [
        { index: 0, item: { id: 'm1' }, status: 'success', output: { id: 'm1', subject: 'Invoice', attachments: [{ attachmentId: 'a1' }, { attachmentId: 'a2' }] } },
        { index: 1, item: { id: 'm2' }, status: 'success', output: { id: 'm2', subject: 'Receipt', attachments: [{ attachmentId: 'a3' }] } },
    ],
};
const state = () => ({ trigger: { output: {} }, steps: { shop: { output: SHOP }, read: { output: READ } }, vars: {}, secrets: {}, loop: {} });
const echo = async (_s, _ctx, sub) => ({ output: { ...sub.loop } });

test('per line item, the order each line item belongs to stays bound under its old name', async () => {
    const step = {
        id: 's', type: 'integration_action', tool: 'x',
        forEach: { overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }] },
    };
    const out = await execForEachStep(step, {}, state(), 'live', echo);
    assert.deepStrictEqual(out.output.results.map(r => [r.output.order.id, r.output.line_item.id]), [[1001, 9001], [1001, 9002], [1002, 9003]]);
    // The envelope still records the item itself, not the parent.
    assert.deepStrictEqual(out.output.results.map(r => r.item.id), [9001, 9002, 9003]);
});

test('per attachment of every read mail, `loop.result` is still that mail (the envelope output)', async () => {
    const step = {
        id: 's', type: 'integration_action', tool: 'gmail_read_attachment',
        forEach: { overRef: 'steps.read.output.results[*].output.attachments', itemVar: 'attachment', parents: [{ itemVar: 'result', overRef: 'steps.read.output.results[*].output' }] },
    };
    const out = await execForEachStep(step, {}, state(), 'dry_run', echo);
    assert.deepStrictEqual(out.output.results.map(r => [r.output.result.id, r.output.attachment.attachmentId]), [['m1', 'a1'], ['m1', 'a2'], ['m2', 'a3']]);
});

test('two levels down, both the order and the line item stay bound', async () => {
    const step = {
        id: 's', type: 'integration_action', tool: 'x',
        forEach: {
            overRef: 'steps.shop.output.orders[*].line_items[*].properties',
            itemVar: 'property',
            parents: [
                { itemVar: 'order', overRef: 'steps.shop.output.orders' },
                { itemVar: 'line_item', overRef: 'steps.shop.output.orders[*].line_items' },
            ],
        },
    };
    const out = await execForEachStep(step, {}, state(), 'live', echo);
    assert.deepStrictEqual(
        out.output.results.map(r => [r.output.order.id, r.output.line_item.sku, r.output.property.value]),
        [[1001, 'TSHIRT-M', 'Tom'], [1001, 'MUG', 'yes'], [1002, 'CAP', 'Red']],
    );
});

test('a parent that is not part of the overRef, or reuses the item name, binds nothing', async () => {
    const step = {
        id: 's', type: 'integration_action', tool: 'x',
        forEach: {
            overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item',
            parents: [{ itemVar: 'order', overRef: 'steps.other.output.orders' }, { itemVar: 'line_item', overRef: 'steps.shop.output.orders' }, null],
        },
    };
    const out = await execForEachStep(step, {}, state(), 'live', echo);
    assert.strictEqual(out.output.iterations, 3);
    assert.ok(out.output.results.every(r => !('order' in r.output)));
    assert.strictEqual(out.output.results[0].output.line_item.id, 9001);
});

test('a list path that matches nothing in the data is reported, not run zero times in green', async () => {
    // The old two-level deepen wrote this: `.properties` looked up on each order's line_items ARRAY.
    const step = { id: 's', type: 'integration_action', tool: 'x', forEach: { overRef: 'steps.shop.output.orders[*].line_items.properties', itemVar: 'property' } };
    const out = await execForEachStep(step, {}, state(), 'live', echo);
    assert.strictEqual(out.skippedReason, 'overref_unresolved');
    assert.strictEqual(out.output.iterations, 0);
    assert.match(out.output.skipped, /line_items\.properties/);
    assert.match(out.output.skipped, /none of the 3/);
});

test('a genuinely empty list is still a clean pass with zero runs', async () => {
    const s = state();
    s.steps.shop.output = { orders: [{ id: 1, line_items: [] }, { id: 2, line_items: [] }] };
    const step = { id: 's', type: 'integration_action', tool: 'x', forEach: { overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item' } };
    const out = await execForEachStep(step, {}, s, 'live', echo);
    assert.strictEqual(out.skippedReason, undefined);
    assert.strictEqual(out.output.iterations, 0);
    const none = { id: 'n', type: 'integration_action', tool: 'x', forEach: { overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item' } };
    s.steps.shop.output = { orders: [] };
    assert.strictEqual((await execForEachStep(none, {}, s, 'live', echo)).skippedReason, undefined);
});

test('a failed item keeps its slot: results[*].output stays aligned with results[*].item', async () => {
    const s = { trigger: { output: {} }, steps: { src: { output: { ids: ['m1', 'm2', 'm3'] } } }, vars: {}, secrets: {}, loop: {} };
    const step = { id: 's', type: 'integration_action', tool: 'x', forEach: { overRef: 'steps.src.output.ids', itemVar: 'id' } };
    const leaf = async (_s, _c, sub) => {
        if (sub.loop.id === 'm2') throw new Error('404');
        return { output: { subject: `subj-${sub.loop.id}` } };
    };
    const out = await execForEachStep(step, {}, s, 'live', leaf);
    assert.strictEqual(out.output.results[1].status, 'error');
    assert.strictEqual(out.output.results[1].output, null);
    const root = { steps: { s: { output: out.output } } };
    assert.deepStrictEqual(walkPath('steps.s.output.results[*].item', root), ['m1', 'm2', 'm3']);
    assert.deepStrictEqual(walkPath('steps.s.output.results[*].output.subject', root), ['subj-m1', 'subj-m3']);
    // The whole output column keeps three slots, the failed one as null.
    assert.deepStrictEqual(walkPath('steps.s.output.results[*].output', root), [{ subject: 'subj-m1' }, null, { subject: 'subj-m3' }]);
});

test('the trail walk yields exactly what walkPath yields', () => {
    const root = state();
    for (const p of [
        'steps.shop.output.orders',
        'steps.shop.output.orders[*]',
        'steps.shop.output.orders[*].line_items',
        'steps.shop.output.orders[*].line_items[*].properties',
        'steps.shop.output.orders[*].line_items[*].properties[*].value',
        'steps.read.output.results[*].output.attachments',
        'steps.shop.output.orders[*].id',
    ]) {
        const walked = walkWithTrail(parsePath(p), root);
        assert.deepStrictEqual(walked.entries.map(e => e.value), walkPath(p, root), p);
    }
    // JSON text is a list too.
    const text = { steps: { h: { output: { body: JSON.stringify({ value: [{ id: 'e1', attendees: [{ a: 1 }, { a: 2 }] }] }) } } } };
    const fe = { overRef: 'steps.h.output.body.value[*].attendees', itemVar: 'attendee', parents: [{ itemVar: 'event', overRef: 'steps.h.output.body.value' }] };
    const list = walkPath(fe.overRef, text);
    assert.deepStrictEqual(resolveForEachItems(fe, text, list).scopes.map(s => s.event.id), ['e1', 'e1']);
});
