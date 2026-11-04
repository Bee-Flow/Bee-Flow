/**
 * filterGroups.mjs: `{ any: [...] }` OR groups and the one loop that resolves
 * a filter list's dynamic values, in read semantics (runtime, render, step
 * reads, dry run) and strict semantics (writes: never widen).
 * Run: node --test server/shared/expr/filterGroups.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    FILTER_SKIP, MAX_FILTER_CLAUSES, countFilterLeaves, forEachFilterClause, isAnyGroup, resolveFilterList,
} from './filterGroups.mjs';

const F = (expr) => ({ kind: 'formula', expr });
const SCOPE = { 'vars.status': 'open', 'vars.empty': undefined, 'vars.blank': '' };
const resolve = (v) => (v && typeof v === 'object' && v.kind === 'formula' ? SCOPE[v.expr] : v);

const OPEN = { field: 'status', op: 'eq', value: F('vars.status') };
const UNSET = { field: 'owner', op: 'eq', value: F('vars.empty') };
const LIT = { field: 'priority', op: 'eq', value: 'high' };

test('isAnyGroup, forEachFilterClause, countFilterLeaves', () => {
    assert.equal(isAnyGroup({ any: [] }), true);
    assert.equal(isAnyGroup({ field: 'x', op: 'eq' }), false);
    assert.equal(isAnyGroup(null), false);
    const seen = [];
    forEachFilterClause([LIT, { any: [OPEN, UNSET] }], (c, at) => seen.push(at));
    assert.deepEqual(seen, ['[0]', '[1].any[0]', '[1].any[1]']);
    assert.equal(countFilterLeaves([LIT, { any: [OPEN, UNSET] }, LIT]), 4);
    assert.equal(countFilterLeaves('not a list'), 0);
    assert.equal(MAX_FILTER_CLAUSES, 50);
});

test('read: an unchanged list keeps its identity, entries too', () => {
    const list = [LIT, { any: [LIT, { field: 'a', op: 'isNull' }] }];
    const res = resolveFilterList(list, resolve);
    assert.equal(res.status, 'ok');
    assert.equal(res.changed, false);
    assert.strictEqual(res.filters[0], list[0]);
    assert.strictEqual(res.filters[1], list[1], 'an untouched group is the same object');
});

test('read: formula values resolve inside a group; unresolved clauses drop', () => {
    const res = resolveFilterList([{ any: [OPEN, UNSET, LIT] }], resolve);
    assert.deepEqual(res, { status: 'ok', changed: true, filters: [{ any: [{ field: 'status', op: 'eq', value: 'open' }, LIT] }] });
});

test('read: a group left empty is dropped; a required one means no query', () => {
    assert.deepEqual(resolveFilterList([LIT, { any: [UNSET] }], resolve), { status: 'ok', changed: true, filters: [LIT] });
    assert.deepEqual(resolveFilterList([LIT, { any: [UNSET], required: true }], resolve), { status: 'required' });
});

test('read: a required clause inside a group with no value means no query', () => {
    assert.deepEqual(resolveFilterList([{ any: [{ ...UNSET, required: true }, LIT] }], resolve), { status: 'required' });
});

test('read: top-level rules are unchanged (required, drop, rewrite strips required)', () => {
    assert.deepEqual(resolveFilterList([UNSET, LIT], resolve), { status: 'ok', changed: true, filters: [LIT] });
    assert.deepEqual(resolveFilterList([{ ...UNSET, required: true }], resolve), { status: 'required' });
    assert.deepEqual(resolveFilterList([{ ...OPEN, required: true }], resolve).filters, [{ field: 'status', op: 'eq', value: 'open' }]);
    assert.deepEqual(resolveFilterList(['junk', LIT], resolve).filters, ['junk', LIT], 'malformed entries pass through by default');
    assert.deepEqual(resolveFilterList(['junk', LIT], resolve, { keepMalformed: false }).filters, [LIT]);
});

test('read: a group that changed drops its own required flag, like a rewritten clause', () => {
    const res = resolveFilterList([{ any: [OPEN, UNSET], required: true }], resolve);
    assert.deepEqual(res.filters, [{ any: [{ field: 'status', op: 'eq', value: 'open' }] }]);
});

test('FILTER_SKIP from resolveValue skips the whole list, inside a group too', () => {
    const skip = (v) => (v && v.kind === 'formula' ? FILTER_SKIP : v);
    assert.deepEqual(resolveFilterList([LIT, { any: [OPEN] }], skip), { status: 'skip' });
    assert.deepEqual(resolveFilterList([OPEN], skip), { status: 'skip' });
});

test('options: isUnset, noValueOps, ignoreRequired', () => {
    const blank = { field: 'q', op: 'eq', value: F('vars.blank') };
    assert.equal(resolveFilterList([blank], resolve).filters.length, 1, "'' is a value by default");
    assert.equal(resolveFilterList([blank], resolve, { isUnset: (v) => v == null || v === '' }).filters.length, 0);
    const isNull = { field: 'q', op: 'isNull' };
    assert.deepEqual(resolveFilterList([isNull], resolve).filters, [isNull]);
    assert.deepEqual(resolveFilterList([isNull], resolve, { noValueOps: false }).filters, [], 'the step-read quirk: no value, dropped');
    assert.deepEqual(resolveFilterList([{ ...UNSET, required: true }, LIT], resolve, { ignoreRequired: true }).filters, [LIT]);
    assert.deepEqual(resolveFilterList([{ any: [UNSET], required: true }], resolve, { ignoreRequired: true }).filters, []);
});

test('strict: any unresolved top-level clause blocks and names its field', () => {
    assert.deepEqual(resolveFilterList([LIT, UNSET], resolve, { strict: true }), { status: 'blocked', field: 'owner' });
});

test('strict: inside a group an unresolved clause narrows the group', () => {
    assert.deepEqual(resolveFilterList([{ any: [OPEN, UNSET] }], resolve, { strict: true }),
        { status: 'ok', changed: true, filters: [{ any: [{ field: 'status', op: 'eq', value: 'open' }] }] });
});

test('strict: a group whose clauses all resolve empty BLOCKS, never widens', () => {
    assert.deepEqual(resolveFilterList([LIT, { any: [UNSET, { ...UNSET, field: 'other' }] }], resolve, { strict: true }), { status: 'blocked', field: 'owner' });
});

test('strict: isNull/isNotNull keep their meaning', () => {
    const isNull = { field: 'q', op: 'isNull' };
    assert.deepEqual(resolveFilterList([isNull, { any: [{ field: 'r', op: 'isNotNull' }] }], resolve, { strict: true }).filters,
        [isNull, { any: [{ field: 'r', op: 'isNotNull' }] }]);
});

test('not a list resolves to an empty list', () => {
    assert.deepEqual(resolveFilterList(undefined, resolve), { status: 'ok', filters: [], changed: false });
});
