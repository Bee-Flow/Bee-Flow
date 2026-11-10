import { describe, expect, it } from 'vitest';
import { buildDescriptor } from './QueryBuilder';
import { outputColumnsOf, withSortLimit } from './datasetShape';

const FIELDS = [
    { id: 'f1', key: 'region', name: 'Region', type: 'text' },
    { id: 'f2', key: 'amount', name: 'Amount', type: 'number' },
    { id: 'f3', key: 'created', name: 'Created', type: 'date' },
];

describe('dataset sort and limit', () => {
    it('names the output columns the way the compiler does (as, field, field_bucket)', () => {
        expect(outputColumnsOf({
            groupBy: [{ field: 'region' }, { field: 'created', bucket: 'month' }, { field: 'x', as: 'ex' }],
            aggregates: [{ as: 'count' }, { as: 'sum_amount' }],
        })).toEqual(['region', 'created_month', 'ex', 'count', 'sum_amount']);
    });

    it('adds sort and limit only when set, and leaves the descriptor byte-identical otherwise', () => {
        const plain = buildDescriptor('t', FIELDS, [{ field: 'region' }], [{ agg: 'count', label: 'n' }], []).descriptor;
        expect(plain).toEqual({ groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'n' }], filters: [] });
        expect(Object.keys(plain)).toEqual(['groupBy', 'aggregates', 'filters']);
        expect(withSortLimit(plain, null, null)).toEqual(plain);
        const shaped = withSortLimit(plain, { field: 'n', dir: 'desc' }, 5);
        expect(shaped).toEqual({ ...plain, sort: [{ field: 'n', dir: 'desc' }], limit: 5 });
    });

    it('drops a sort that names a column the answer no longer has, and a limit that is not a positive integer', () => {
        const d = { groupBy: [{ field: 'region' }], aggregates: [] };
        expect(withSortLimit(d, { field: 'gone', dir: 'asc' }, 0)).toEqual(d);
        expect(withSortLimit(d, null, 2.5)).toEqual(d);
    });
});

describe('dataset either/or filter groups', () => {
    it('keeps an any group with its complete clauses, in the shape the compiler reads', () => {
        const { descriptor, unknownFields, valid } = buildDescriptor('t', FIELDS, [{ field: 'region' }], [{ agg: 'count' }], [
            { field: 'amount', op: 'gt', value: '10' },
            { any: [
                { field: 'region', op: 'eq', value: 'North' },
                { field: 'region', op: 'eq', value: 'South' },
                { field: '', op: 'eq', value: '' },
            ] },
        ]);
        expect(descriptor.filters).toEqual([
            { field: 'amount', op: 'gt', value: 10 },
            { any: [{ field: 'region', op: 'eq', value: 'North' }, { field: 'region', op: 'eq', value: 'South' }] },
        ]);
        expect(unknownFields).toEqual([]);
        expect(valid).toBe(true);
    });

    it('drops a group left with no complete clause, and flags a clause on a field the table lacks', () => {
        const empty = buildDescriptor('t', FIELDS, [{ field: 'region' }], [], [{ any: [{ field: '', op: 'eq', value: '' }] }]);
        expect(empty.descriptor.filters).toEqual([]);
        const ghost = buildDescriptor('t', FIELDS, [{ field: 'region' }], [], [{ any: [{ field: 'ghost', op: 'eq', value: 1 }] }]);
        expect(ghost.unknownFields).toEqual(['ghost']);
        expect(ghost.valid).toBe(false);
    });
});
