/**
 * Unit tests for the shared server-side data-binding collector
 * (appStudio/collectDataBindings.js).
 *
 * Run: node --test appStudio/collectDataBindings.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { collectDataBindings } = require('./collectDataBindings');

function def(screens) { return { screens }; }

test('collects record/records/dataset bindings with node id + prop, skips other kinds', () => {
    const d = def([{
        id: 'scr_1', sections: [{
            id: 'sec_1', children: [
                { id: 'cmp_a', type: 'table', props: { source: { kind: 'records', tableId: 'tbl_x' } } },
                { id: 'cmp_b', type: 'stat', props: { value: { kind: 'dataset', datasetId: 'ds_y' }, label: 'Count' } },
                { id: 'cmp_c', type: 'text', props: { text: { kind: 'formula', expr: '1+1' } } }, // not a data binding
                { id: 'cmp_d', type: 'text', props: { text: { kind: 'static', value: 'hi' } } },
            ],
        }],
    }]);
    const out = collectDataBindings(d);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map((b) => [b.nodeId, b.prop, b.binding.kind]), [
        ['cmp_a', 'source', 'records'],
        ['cmp_b', 'value', 'dataset'],
    ]);
});

test('descends into container children and nested prop objects/arrays', () => {
    const d = def([{
        id: 'scr_1', sections: [{
            id: 'sec_1', children: [{
                id: 'cmp_card', type: 'card', props: {}, children: [
                    { id: 'cmp_inner', type: 'record_detail', props: { record: { kind: 'record', tableId: 'tbl_z' } } },
                ],
            }],
        }],
    }]);
    const out = collectDataBindings(d);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual([out[0].nodeId, out[0].prop, out[0].binding.kind], ['cmp_inner', 'record', 'record']);
});

test('a binding is not descended into (its filter formula is not a fetched binding)', () => {
    const d = def([{
        id: 'scr_1', sections: [{
            id: 'sec_1', children: [{
                id: 'cmp_a', type: 'table',
                props: { source: { kind: 'records', tableId: 'tbl_x', filter: [{ field: 'a', op: 'eq', value: { kind: 'formula', expr: 'vars.x' } }] } },
            }],
        }],
    }]);
    const out = collectDataBindings(d);
    assert.strictEqual(out.length, 1, 'only the outer records binding, not its inner formula');
    assert.strictEqual(out[0].binding.kind, 'records');
});

test('screenId narrows to one screen; unknown id yields nothing', () => {
    const d = def([
        { id: 'scr_1', sections: [{ id: 's1', children: [{ id: 'c1', type: 'table', props: { source: { kind: 'records', tableId: 'tbl_1' } } }] }] },
        { id: 'scr_2', sections: [{ id: 's2', children: [{ id: 'c2', type: 'table', props: { source: { kind: 'records', tableId: 'tbl_2' } } }] }] },
    ]);
    assert.strictEqual(collectDataBindings(d, 'scr_2').length, 1);
    assert.strictEqual(collectDataBindings(d, 'scr_2')[0].nodeId, 'c2');
    assert.strictEqual(collectDataBindings(d, 'scr_missing').length, 0);
    assert.strictEqual(collectDataBindings(d).length, 2, 'no screenId → every screen');
});

test('malformed input never throws', () => {
    assert.deepStrictEqual(collectDataBindings(null), []);
    assert.deepStrictEqual(collectDataBindings({}), []);
    assert.deepStrictEqual(collectDataBindings({ screens: [null, { sections: [null, { children: [null, 42] }] }] }), []);
});
