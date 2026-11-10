/**
 * The binding planner's three option sets, pinned case by case. Each column is
 * what that caller did before the planner existed (the web runtime, the
 * screenshot render, the dry run); a change in any cell is a behaviour change
 * for that caller, never a refactor.
 *
 *   'same'        fetch, the input binding itself (identity kept)
 *   'skip'        no query (a required filter has no value, or not a data binding)
 *   'needsScope'  a formula reads a root this caller cannot fill
 *   { ... }       fetch this resolved binding
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_PLAN, RENDER_PLAN, DRY_RUN_PLAN, planBinding, planFilters, planShape, planParams } from './bindingPlan.mjs';

const SCOPE = Object.freeze({
    vars: { q: 'abc', none: null, dim: 'status' },
    currentUser: { id: 'u1' },
    forms: {},
    screen: { params: {} },
    item: { id: 'i1' },
    now: 1000,
    today: '2026-01-01',
});

const f = (expr) => ({ kind: 'formula', expr });
const T = { kind: 'records', tableId: 't1' };
const clause = (value, extra = {}) => ({ field: 'x', op: 'eq', value, ...extra });
const recs = (filter) => ({ ...T, filter });
const agg = (extra) => ({ kind: 'aggregate', tableId: 't1', ...extra });

// [name, binding, client, render, dryRun]. Client and render go through
// planBinding (shape, then filters: AppDataScope's and buildDataState's order);
// the dry run through planFilters (resolveDryRunFilters).
const CASES = [
    ['no filter', T, 'same', 'same', T],
    ['literal filter unchanged', recs([clause('lit')]), 'same', 'same', recs([clause('lit')])],
    ['currentUser formula', recs([clause(f('currentUser.id'))]), recs([clause('u1')]), recs([clause('u1')]), recs([clause('u1')])],
    ['optional formula resolving to null', recs([clause(f('vars.none'))]), T, T, recs([])],
    ['required formula resolving to null', recs([clause(f('vars.none'), { required: true })]), 'skip', 'skip', recs([])],
    ['required formula with a value', recs([clause(f('vars.q'), { required: true })]), recs([clause('abc')]), recs([clause('abc')]), recs([clause('abc')])],
    ['item root', recs([clause(f('item.id'))]), recs([clause('i1')]), 'needsScope', 'needsScope'],
    ['now root', recs([clause(f('now'))]), recs([clause(1000)]), 'needsScope', recs([clause(1000)])],
    ['today root', recs([clause(f('today'))]), recs([clause('2026-01-01')]), recs([clause('2026-01-01')]), recs([clause('2026-01-01')])],
    ['literal null value', recs([clause(null)]), T, T, recs([clause(null)])],
    ['empty formula', recs([clause(f(''))]), T, 'needsScope', 'needsScope'],
    ['formula that does not compile', recs([clause(f('(('))]), T, 'needsScope', 'needsScope'],
    ['non-string expr', recs([clause(f(5))]), T, T, recs([])],
    ['legacy whole-filter string', recs('vars.q'), 'same', 'same', 'needsScope'],
    ['legacy object filter', recs({ x: 1 }), 'same', 'same', T],
    ['empty filter list', recs([]), 'same', 'same', recs([])],
    ['isNull passes through', recs([{ field: 'x', op: 'isNull' }]), 'same', 'same', recs([{ field: 'x', op: 'isNull' }])],
    ['any group, one clause unresolved', recs([{ any: [clause('a'), clause(f('vars.none'))] }]), recs([{ any: [clause('a')] }]), recs([{ any: [clause('a')] }]), recs([{ any: [clause('a')] }])],
    ['required any group emptied', recs([{ any: [clause(f('vars.none'))], required: true }]), 'skip', 'skip', recs([])],
    ['any group with an item root', recs([{ any: [clause('a'), clause(f('item.id'))] }]), recs([{ any: [clause('a'), clause('i1')] }]), 'needsScope', 'needsScope'],
    ['aggregate groupBy formula', agg({ groupBy: f('vars.dim') }), agg({ groupBy: 'status' }), agg({ groupBy: 'status' }), agg({ groupBy: f('vars.dim') })],
    ['aggregate groupBy resolving to nothing', agg({ groupBy: f('vars.none'), limit: 5 }), agg({ limit: 5 }), agg({ limit: 5 }), agg({ groupBy: f('vars.none'), limit: 5 })],
    ['aggregate shape with an item root', agg({ sort: f('item.id') }), agg({ sort: 'i1' }), 'needsScope', agg({ sort: f('item.id') })],
    ['aggregate literal shape and filter', agg({ groupBy: [{ field: 'x' }], filter: [clause(f('vars.q'))] }), agg({ groupBy: [{ field: 'x' }], filter: [clause('abc')] }), agg({ groupBy: [{ field: 'x' }], filter: [clause('abc')] }), agg({ groupBy: [{ field: 'x' }], filter: [clause('abc')] })],
    ['dataset', { kind: 'dataset', datasetId: 'd1' }, 'same', 'same', { kind: 'dataset', datasetId: 'd1' }],
];

/** @param {import('./bindingPlan.mjs').BindingPlan} plan */
function outcome(plan, input) {
    if (plan.plan !== 'fetch') return plan.plan;
    return plan.binding === input ? 'same' : plan.binding;
}

for (const [name, binding, client, render, dryRun] of CASES) {
    test(`planner: ${name}`, () => {
        assert.deepEqual(outcome(planBinding(binding, SCOPE, CLIENT_PLAN), binding), client, 'client');
        assert.deepEqual(outcome(planBinding(binding, SCOPE, RENDER_PLAN), binding), render, 'render');
        assert.deepEqual(outcome(planFilters(binding, SCOPE, DRY_RUN_PLAN), binding), dryRun, 'dry run');
    });
}

test('planner: connector params resolve client-side, an unresolved param is omitted', () => {
    const b = { kind: 'connector', connectorId: 'c1', params: { q: f('vars.q'), gone: f('vars.missing'), keep: null, zero: 0 } };
    assert.deepEqual(planBinding(b, SCOPE, CLIENT_PLAN), { plan: 'fetch', binding: { ...b, params: { q: 'abc', keep: null, zero: 0 } } });
    const literal = { kind: 'connector', connectorId: 'c1', params: { a: 1 } };
    assert.equal(planBinding(literal, SCOPE, CLIENT_PLAN).binding, literal);
    assert.deepEqual(planBinding({ kind: 'connector', connectorId: 'c1', params: { id: f('item.id') } }, SCOPE, RENDER_PLAN), { plan: 'needsScope' });
});

test('planner: a binding that is not a data binding is skip', () => {
    for (const b of [null, undefined, 7, 'text', {}, { kind: 'static', value: 1 }, { kind: 'formula', expr: 'vars.q' }]) {
        assert.deepEqual(planBinding(b, SCOPE, CLIENT_PLAN), { plan: 'skip' });
    }
});

test('planner: the client steps pass a non-binding through unchanged', () => {
    for (const step of [planShape, planFilters, planParams]) {
        assert.deepEqual(step(null, SCOPE, CLIENT_PLAN), { plan: 'fetch', binding: null });
    }
    assert.deepEqual(planFilters(null, SCOPE, DRY_RUN_PLAN), { plan: 'fetch', binding: {} });
});

test('planner: the option sets differ only where their callers did', () => {
    assert.deepEqual(CLIENT_PLAN, { resolveShape: true, scopeRoots: null, filterMode: 'live' });
    assert.deepEqual([...RENDER_PLAN.scopeRoots].sort(), ['currentUser', 'forms', 'screen', 'today', 'vars']);
    assert.deepEqual([...DRY_RUN_PLAN.scopeRoots].sort(), ['currentUser', 'forms', 'now', 'screen', 'today', 'vars']);
    assert.equal(RENDER_PLAN.resolveShape, true);
    assert.equal(DRY_RUN_PLAN.resolveShape, false);
    assert.equal(DRY_RUN_PLAN.filterMode, 'probe');
});
