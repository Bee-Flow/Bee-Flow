import { describe, expect, it } from 'vitest';
import { dataCacheKey, resolveBindingFilters } from './resolveBinding';
import type { DataBinding } from './resolveBinding.types';

/**
 * `orderBy` and filter trees in the runtime's binding layer: a binding without
 * `orderBy` keeps the cache key it always had, one with it gets its own, and
 * formula values resolve inside nested groups.
 */

describe('dataCacheKey with orderBy', () => {
    const base: DataBinding = { kind: 'records', tableId: 'tbl_a', filter: [{ field: 'status', op: 'eq', value: 'open' }], sort: [{ field: 'due', dir: 'asc' }], limit: 5 };

    it('is unchanged for a binding without orderBy', () => {
        expect(dataCacheKey(base)).toBe('records:tbl_a:{"filter":[{"field":"status","op":"eq","value":"open"}],"limit":5,"sort":[{"dir":"asc","field":"due"}]}');
        expect(dataCacheKey({ kind: 'aggregate', tableId: 'tbl_a', aggregates: [{ fn: 'count', as: 'n' }] }))
            .toBe('aggregate:tbl_a:{"aggregates":[{"as":"n","fn":"count"}],"filter":null,"groupBy":null,"limit":null,"sort":null}');
    });

    it('differs per orderBy', () => {
        const a = dataCacheKey({ ...base, orderBy: [{ field: 'status', dir: 'asc' }, { field: 'due', dir: 'desc' }] });
        const b = dataCacheKey({ ...base, orderBy: [{ field: 'status', dir: 'asc' }, { field: 'due', dir: 'asc' }] });
        expect(a).not.toBe(dataCacheKey(base));
        expect(a).not.toBe(b);
        expect(a).toContain('"orderBy":[');
    });
});

describe('resolveBindingFilters with a tree', () => {
    it('resolves formula values at any depth and drops what does not resolve', () => {
        const binding: DataBinding = {
            kind: 'records', tableId: 'tbl_a',
            filter: [{ any: [
                { all: [{ field: 'owner', op: 'eq', value: { kind: 'formula', expr: 'currentUser.id' } }, { field: 'spent', op: 'gt', otherField: 'budget' }] },
                { not: { field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.nothing' } } },
            ] }],
        };
        const out = resolveBindingFilters(binding, { currentUser: { id: 'u1' }, vars: {} });
        expect((out as DataBinding).filter).toEqual([{ any: [{ all: [{ field: 'owner', op: 'eq', value: 'u1' }, { field: 'spent', op: 'gt', otherField: 'budget' }] }] }]);
    });
});
