import { describe, expect, it } from 'vitest';
import { applyParamRows, isParamName, paramProblems, paramTypeFor, type ParamRow } from './datasetParamRows';

const fields = [
    { key: 'region', name: 'Region', type: 'text' },
    { key: 'amount', name: 'Amount', type: 'number' },
    { key: 'paid', name: 'Paid', type: 'bool' },
    { key: 'due', name: 'Due', type: 'date' },
];
const base = { groupBy: [{ field: 'region' }], aggregates: [{ fn: 'count', as: 'count' }], filters: [{ field: 'paid', op: 'eq', value: true }] };
const row = (over: Partial<ParamRow>): ParamRow => ({ name: 'p', field: 'region', op: 'eq', defaultValue: '', required: false, ...over });

describe('applyParamRows', () => {
    it('leaves a view without parameters as the same object', () => {
        const out = applyParamRows(base, [], fields);
        expect(out.saved).toBe(base);
        expect(out.preview).toBe(base);
    });

    it('declares each parameter and appends its clause; the preview runs the defaults', () => {
        const out = applyParamRows(base, [
            row({ name: 'region' }),
            row({ name: 'min', field: 'amount', op: 'gte', defaultValue: '10,5', required: true }),
            row({ name: 'isPaid', field: 'paid', defaultValue: 'false' }),
        ], fields);
        expect(out.saved).toEqual({
            ...base,
            params: [{ name: 'region' }, { name: 'min', type: 'number', default: 10.5 }, { name: 'isPaid', type: 'boolean', default: false }],
            filters: [
                { field: 'paid', op: 'eq', value: true },
                { field: 'region', op: 'eq', value: { param: 'region' } },
                { field: 'amount', op: 'gte', value: { param: 'min' }, required: true },
                { field: 'paid', op: 'eq', value: { param: 'isPaid' } },
            ],
        });
        expect(out.preview).toEqual({
            ...base,
            filters: [
                { field: 'paid', op: 'eq', value: true },
                { field: 'amount', op: 'gte', value: 10.5 },
                { field: 'paid', op: 'eq', value: false },
            ],
        });
        expect('params' in out.preview).toBe(false);
    });
});

describe('paramProblems', () => {
    it('names what is wrong with a row', () => {
        expect(paramProblems([
            row({ name: '' }),
            row({ name: 'a' }),
            row({ name: 'a' }),
            row({ name: 'b', field: '' }),
            row({ name: 'c', field: 'amount', defaultValue: 'lots' }),
            row({ name: 'd', field: 'due', defaultValue: '2026-01-31' }),
        ], fields)).toEqual({ 0: 'name', 2: 'duplicate', 3: 'field', 4: 'default' });
    });
});

describe('names and types', () => {
    it('follows the server grammar', () => {
        expect(isParamName('_a1')).toBe(true);
        expect(isParamName('1a')).toBe(false);
        expect(isParamName('a-b')).toBe(false);
        expect(isParamName('x'.repeat(41))).toBe(false);
    });

    it('takes the type from the column', () => {
        expect(paramTypeFor('number')).toBe('number');
        expect(paramTypeFor('bool')).toBe('boolean');
        expect(paramTypeFor('datetime')).toBe('date');
        expect(paramTypeFor('select')).toBe('text');
        expect(paramTypeFor(undefined)).toBe('text');
    });
});
