'use strict';

// Strict resolution of a write filter (writeTarget.resolveStrictFilters) with OR groups:
// a write never widens (PLAN decision 13).
// Run: cd server && node --test appStudio/actionExecutor/writeTarget.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveStrictFilters } = require('./writeTarget.mts');

const f = (expr) => ({ kind: 'formula', expr });
const scope = { 'vars.a': 'x', 'vars.empty': '' };
const resolve = (b) => scope[b.expr];

test('top level: resolved values replace bindings; an empty one blocks the write', () => {
    assert.deepEqual(resolveStrictFilters([{ field: 'a', op: 'eq', value: f('vars.a'), required: true }, { field: 'b', op: 'isNull' }], resolve),
        { filters: [{ field: 'a', op: 'eq', value: 'x' }, { field: 'b', op: 'isNull' }], blocked: false });
    assert.deepEqual(resolveStrictFilters([{ field: 'a', op: 'eq', value: f('vars.empty') }], resolve), { filters: [], blocked: true, field: 'a' });
});

test('an any group: an empty member drops out (narrows), an emptied group blocks', () => {
    const out = resolveStrictFilters([{ field: 's', op: 'eq', value: 'done' }, { any: [{ field: 'a', op: 'eq', value: f('vars.a') }, { field: 'c', op: 'eq', value: f('vars.empty') }] }], resolve);
    assert.deepEqual(out, { filters: [{ field: 's', op: 'eq', value: 'done' }, { any: [{ field: 'a', op: 'eq', value: 'x' }] }], blocked: false });
    const blocked = resolveStrictFilters([{ field: 's', op: 'eq', value: 'done' }, { any: [{ field: 'c', op: 'eq', value: f('vars.empty') }] }], resolve);
    assert.deepEqual(blocked, { filters: [], blocked: true, field: 'c' });
});

test('malformed: a string, an empty list, a non-object, an empty or nested group are refused', () => {
    for (const bad of ['s == 1', [], [1], [{ any: [] }], [{ any: [{ any: [{ field: 'a', op: 'eq', value: 1 }] }] }]]) {
        assert.throws(() => resolveStrictFilters(bad, resolve), (e) => e.safe === true && /filter_invalid|bulk_filter_empty/.test(e.code), JSON.stringify(bad));
    }
});
