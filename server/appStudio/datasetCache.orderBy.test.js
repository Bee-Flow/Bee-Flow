/**
 * `orderBy` in the two places a read is keyed: the dataset cache's params hash
 * and the server render's data cache key. A descriptor or binding without it
 * keeps exactly the key it had; one with it gets its own.
 *
 * Run: node --test appStudio/datasetCache.orderBy.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
require('../testUtils/routeHarness').recordDb();

const { computeParamsHash } = require('./datasetCache');
const { _test: render } = require('../services/appStudioRender');

const DESCRIPTOR = { filters: [{ field: 'status', op: 'eq', value: 'open' }], groupBy: [{ field: 'owner' }], aggregates: [{ fn: 'count', as: 'n' }], sort: [{ field: 'n', dir: 'desc' }], limit: 10 };

test('the params hash of a descriptor without orderBy is the hash it always was', () => {
    const pinned = '{"aggregates":[{"as":"n","fn":"count"}],"filters":[{"field":"status","op":"eq","value":"open"}],"groupBy":[{"field":"owner"}],"limit":10,"sort":[{"dir":"desc","field":"n"}],"table":"tasks"}';
    const expected = crypto.createHash('sha256').update(`params:v1:${pinned}`).digest('hex');
    assert.strictEqual(computeParamsHash('tasks', DESCRIPTOR), expected);
    assert.strictEqual(computeParamsHash('tasks', { ...DESCRIPTOR, orderBy: null }), expected);
});

test('orderBy is part of the params hash when the descriptor has one', () => {
    const a = computeParamsHash('tasks', { ...DESCRIPTOR, orderBy: [{ field: 'n', dir: 'desc' }, { field: 'owner', dir: 'asc' }] });
    const b = computeParamsHash('tasks', { ...DESCRIPTOR, orderBy: [{ field: 'n', dir: 'desc' }, { field: 'owner', dir: 'desc' }] });
    assert.notStrictEqual(a, computeParamsHash('tasks', DESCRIPTOR));
    assert.notStrictEqual(a, b);
});

test('the render key of a binding without orderBy is unchanged; with it, it is the key the browser computes', () => {
    const binding = { kind: 'records', tableId: 'tbl_a', filter: [{ field: 'status', op: 'eq', value: 'open' }], sort: [{ field: 'due', dir: 'asc' }], limit: 5 };
    assert.strictEqual(render.dataCacheKey(binding), 'records:tbl_a:{"filter":[{"field":"status","op":"eq","value":"open"}],"limit":5,"sort":[{"dir":"asc","field":"due"}]}');
    assert.strictEqual(render.dataCacheKey({ kind: 'aggregate', tableId: 'tbl_a', aggregates: [{ fn: 'count', as: 'n' }] }),
        'aggregate:tbl_a:{"aggregates":[{"as":"n","fn":"count"}],"filter":null,"groupBy":null,"limit":null,"sort":null}');
    assert.strictEqual(render.dataCacheKey({ kind: 'records', tableId: 'tbl_a', orderBy: [{ field: 'status', dir: 'asc' }, { field: 'due', dir: 'desc' }] }),
        'records:tbl_a:{"filter":null,"limit":null,"orderBy":[{"dir":"asc","field":"status"},{"dir":"desc","field":"due"}],"sort":null}');
});
