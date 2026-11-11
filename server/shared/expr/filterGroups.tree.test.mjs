/**
 * filterGroups.mjs: `{ all }` / `{ not }` groups, groups inside groups to
 * MAX_FILTER_DEPTH, `{ field, op, otherField }` clauses, and what resolving
 * them means in read semantics and in strict (write) semantics.
 * Run: node --test server/shared/expr/filterGroups.tree.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_FILTER_DEPTH, FIELD_COMPARE_OPS, countFilterLeaves, filterClauseFields, filterDepth, filterGroupMembers,
    forEachFilterClause, isAllGroup, isAnyGroup, isFieldCompare, isFilterGroup, isNotGroup, resolveFilterList,
} from './filterGroups.mjs';

const F = (expr) => ({ kind: 'formula', expr });
const SCOPE = { 'vars.status': 'open', 'vars.empty': undefined };
const resolve = (v) => (v && typeof v === 'object' && v.kind === 'formula' ? SCOPE[v.expr] : v);

const OPEN = { field: 'status', op: 'eq', value: F('vars.status') };
const OPEN_LIT = { field: 'status', op: 'eq', value: 'open' };
const UNSET = { field: 'owner', op: 'eq', value: F('vars.empty') };
const LIT = { field: 'priority', op: 'eq', value: 'high' };
const OVER = { field: 'spent', op: 'gt', otherField: 'budget' };

test('the group predicates: a field next to all or not keeps the entry a clause', () => {
    assert.equal(isAllGroup({ all: [LIT] }), true);
    assert.equal(isAllGroup({ all: [LIT], field: 'x' }), false);
    assert.equal(isAllGroup({ all: 'x' }), false);
    assert.equal(isNotGroup({ not: LIT }), true);
    assert.equal(isNotGroup({ not: [LIT] }), false, 'not takes one entry, not a list');
    assert.equal(isNotGroup({ not: LIT, field: 'x' }), false);
    assert.equal(isAnyGroup({ any: [LIT], all: [LIT] }), true, 'any wins, as before');
    assert.equal(isAllGroup({ any: [LIT], all: [LIT] }), false);
    assert.equal(isFilterGroup({ not: LIT }) && isFilterGroup({ all: [] }) && isFilterGroup({ any: [] }), true);
    assert.equal(isFilterGroup(LIT), false);
    assert.equal(isFieldCompare(OVER), true);
    assert.equal(isFieldCompare(LIT), false);
    assert.deepEqual(FIELD_COMPARE_OPS, ['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
    assert.equal(MAX_FILTER_DEPTH, 3);
    assert.equal(filterGroupMembers(LIT), null);
    assert.deepEqual(filterGroupMembers({ not: LIT }), [{ node: LIT, suffix: '.not' }]);
});

test('clauses are visited at any depth with their path; fields include otherField; depth is counted', () => {
    const tree = [LIT, { any: [{ all: [OPEN, { not: OVER }] }, UNSET] }, { not: { any: [LIT] } }];
    const seen = [];
    forEachFilterClause(tree, (c, at) => seen.push(at));
    assert.deepEqual(seen, ['[0]', '[1].any[0].all[0]', '[1].any[0].all[1].not', '[1].any[1]', '[2].not.any[0]']);
    assert.equal(countFilterLeaves(tree), 5);
    assert.deepEqual(filterClauseFields(tree), ['priority', 'status', 'spent', 'budget', 'owner', 'priority']);
    assert.equal(filterDepth([LIT]), 0);
    assert.equal(filterDepth([{ any: [LIT] }]), 1);
    assert.equal(filterDepth(tree), 3);
    assert.equal(filterDepth([{ any: [{ all: [{ not: { all: [LIT] } }] }] }]), 4);
});

test('a group below the depth limit is not opened: it is one (malformed) clause', () => {
    const deep = [{ any: [{ all: [{ not: { all: [LIT, LIT] } }] }] }];
    const seen = [];
    forEachFilterClause(deep, (c, at) => seen.push([at, c]));
    assert.deepEqual(seen, [['[0].any[0].all[0].not', { all: [LIT, LIT] }]]);
    assert.strictEqual(resolveFilterList(deep, resolve).filters[0], deep[0], 'left for the compiler to refuse');
});

test('read: values resolve at any depth; an untouched tree keeps its identity', () => {
    const tree = [{ any: [{ all: [OPEN, LIT] }, { not: OPEN }] }];
    assert.deepEqual(resolveFilterList(tree, resolve), {
        status: 'ok', changed: true, filters: [{ any: [{ all: [OPEN_LIT, LIT] }, { not: OPEN_LIT }] }],
    });
    const fixed = [{ any: [{ all: [LIT, OVER] }, { not: LIT }] }];
    const res = resolveFilterList(fixed, resolve);
    assert.equal(res.changed, false);
    assert.strictEqual(res.filters[0], fixed[0]);
});

test('read: an unresolved clause drops, an emptied group drops with it, upwards', () => {
    assert.deepEqual(resolveFilterList([{ all: [UNSET, LIT] }], resolve).filters, [{ all: [LIT] }]);
    assert.deepEqual(resolveFilterList([LIT, { all: [UNSET] }], resolve).filters, [LIT]);
    assert.deepEqual(resolveFilterList([LIT, { not: UNSET }], resolve).filters, [LIT]);
    assert.deepEqual(resolveFilterList([LIT, { any: [{ all: [UNSET] }, { not: UNSET }] }], resolve).filters, [LIT]);
    assert.deepEqual(resolveFilterList([{ any: [{ all: [UNSET, LIT] }, OPEN] }], resolve).filters, [{ any: [{ all: [LIT] }, OPEN_LIT] }]);
});

test('read: required means no query, on a nested clause and on a group of any kind', () => {
    assert.deepEqual(resolveFilterList([{ all: [{ ...UNSET, required: true }, LIT] }], resolve), { status: 'required' });
    assert.deepEqual(resolveFilterList([{ any: [{ not: { ...UNSET, required: true } }, LIT] }], resolve), { status: 'required' });
    assert.deepEqual(resolveFilterList([{ all: [UNSET], required: true }], resolve), { status: 'required' });
    assert.deepEqual(resolveFilterList([{ not: UNSET, required: true }], resolve), { status: 'required' });
    assert.deepEqual(resolveFilterList([{ not: UNSET, required: true }], resolve, { ignoreRequired: true }).filters, []);
});

test('a column comparison has no value: it never drops and never blocks', () => {
    assert.strictEqual(resolveFilterList([OVER], resolve).filters[0], OVER);
    assert.strictEqual(resolveFilterList([OVER], resolve, { strict: true }).filters[0], OVER);
    assert.deepEqual(resolveFilterList([{ not: OVER }], resolve, { strict: true }).filters, [{ not: OVER }]);
});

test('strict: a resolved tree passes; dropping only narrows inside an any that is not under a not', () => {
    const strict = (list) => resolveFilterList(list, resolve, { strict: true });
    assert.deepEqual(strict([{ all: [OPEN, LIT] }, { not: OPEN }]).filters, [{ all: [OPEN_LIT, LIT] }, { not: OPEN_LIT }]);
    // any at the top: an unresolved alternative narrows.
    assert.deepEqual(strict([{ any: [OPEN, UNSET] }]).filters, [{ any: [OPEN_LIT] }]);
    // any inside all: still an OR that only loses an alternative.
    assert.deepEqual(strict([{ all: [LIT, { any: [OPEN, UNSET] }] }]).filters, [{ all: [LIT, { any: [OPEN_LIT] }] }]);
});

test('strict: an unresolved clause anywhere it would widen blocks the write', () => {
    const strict = (list) => resolveFilterList(list, resolve, { strict: true });
    assert.deepEqual(strict([{ all: [LIT, UNSET] }]), { status: 'blocked', field: 'owner' });
    assert.deepEqual(strict([{ any: [LIT, { all: [OPEN, UNSET] }] }]), { status: 'blocked', field: 'owner' });
    assert.deepEqual(strict([{ not: UNSET }]), { status: 'blocked', field: 'owner' });
    // Under a not, losing an alternative of an any makes the negation match more rows.
    assert.deepEqual(strict([{ not: { any: [LIT, UNSET] } }]), { status: 'blocked', field: 'owner' });
    assert.deepEqual(strict([{ not: { all: [LIT, UNSET] } }]), { status: 'blocked', field: 'owner' });
    assert.deepEqual(strict([{ any: [LIT, { not: { any: [OPEN, UNSET] } }] }]), { status: 'blocked', field: 'owner' });
    // An any left empty blocks, nested too.
    assert.deepEqual(strict([{ all: [LIT, { any: [UNSET] }] }]), { status: 'blocked', field: 'owner' });
});
