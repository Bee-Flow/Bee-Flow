/**
 * The pure half of the dependents index: which steps touch which table, and
 * where each step sits in the graph.
 *
 * `flowOrder` is a port of the builder's flow/flowOrder.js. The number a
 * datatable's used-by panel shows ("step 4") has to be the number the canvas
 * shows, so the two walks have to agree — the fixtures below are the same
 * shapes the client suite pins.
 *
 * Run: cd server && node --test --test-force-exit automation/datatableUsage.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { collectDatatableUsage, flowOrder, stepPositions } = require('./datatableUsage');

const DEF = {
    schemaVersion: 2,
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    // Authoring order is the order things were dropped on the canvas — here
    // deliberately the reverse of how they run.
    steps: [
        { id: 's_dt', type: 'datatable', op: 'add_row', datatableId: 'tbl_a', values: { email: 'x' } },
        { id: 'n1', type: 'note', text: 'a note is not a step' },
        { id: 's_http', type: 'http_request', method: 'GET' },
        {
            id: 's_loop', type: 'loop', over: 'rows',
            body: [{ id: 's_inner', type: 'datatable', op: 'find_rows', datatableId: 'tbl_a', where: [{ field: 'email' }] }],
        },
    ],
    edges: [
        { from: 'trg', to: 'n1' }, { from: 'n1', to: 's_http' },
        { from: 's_http', to: 's_loop' }, { from: 's_loop', to: 's_dt' },
    ],
    layers: {
        L1: { steps: [{ id: 'l1_dt', type: 'datatable', op: 'update_rows', datatableId: 'tbl_b', where: [{ field: 'id' }] }] },
    },
};

test('flowOrder follows the edges from the trigger, not the authoring order', () => {
    assert.deepStrictEqual(flowOrder(DEF), ['trg', 'n1', 's_http', 's_loop', 's_dt']);
});

test('flowOrder is total: what a cycle or a missing edge leaves unreachable is appended in authoring order', () => {
    const def = {
        trigger: { id: 'trg' },
        steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        edges: [{ from: 'trg', to: 'a' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }],
    };
    assert.deepStrictEqual(flowOrder(def), ['trg', 'a', 'b', 'c']);
    assert.deepStrictEqual(flowOrder(null), []);
    assert.deepStrictEqual(flowOrder({ steps: [] }), []);
});

test('flowOrder is deterministic across a fork: branches that are ready together come out in steps[] order', () => {
    // Exactly what the client's flowOrder does — the ready set is kept sorted
    // by declaration index — so the number here is the number on the canvas
    // even when the edges were drawn in the other order.
    const def = {
        trigger: { id: 'trg' },
        steps: [{ id: 'second' }, { id: 'first' }, { id: 'join' }],
        edges: [
            { from: 'trg', to: 'first' }, { from: 'trg', to: 'second' },
            { from: 'first', to: 'join' }, { from: 'second', to: 'join' },
        ],
    };
    assert.deepStrictEqual(flowOrder(def), ['trg', 'second', 'first', 'join']);
    assert.deepStrictEqual(flowOrder(def), flowOrder(def), 'the same graph, the same sequence');
});

test('stepPositions numbers steps in run order, skipping the trigger and notes', () => {
    const pos = stepPositions(DEF);
    assert.deepStrictEqual(pos.get('s_http'), { ordinal: 1, type: 'http_request', op: null });
    assert.deepStrictEqual(pos.get('s_loop'), { ordinal: 2, type: 'loop', op: null });
    assert.deepStrictEqual(pos.get('s_dt'), { ordinal: 3, type: 'datatable', op: 'add_row' });
    assert.strictEqual(pos.has('trg'), false, 'the trigger is not a step');
    assert.deepStrictEqual(pos.get('n1'), { ordinal: null, type: 'note', op: null }, 'a note is known but unnumbered');
});

test('a step inside a loop body wears its parent\'s number — the one a person can find on the canvas', () => {
    const pos = stepPositions(DEF);
    assert.deepStrictEqual(pos.get('s_inner'), { ordinal: 2, type: 'datatable', op: 'find_rows' });
});

test('an inline flowlet\'s steps are known by type but have no top-level position', () => {
    const pos = stepPositions(DEF);
    assert.deepStrictEqual(pos.get('l1_dt'), { ordinal: null, type: 'datatable', op: 'update_rows' });
});

test('stepPositions and collectDatatableUsage agree on which steps exist', () => {
    const pos = stepPositions(DEF);
    for (const u of collectDatatableUsage(DEF)) {
        assert.ok(pos.has(u.stepId), `${u.stepId} is indexed but has no position`);
    }
    assert.strictEqual(stepPositions(null).size, 0);
    assert.strictEqual(stepPositions('nope').size, 0);
});
