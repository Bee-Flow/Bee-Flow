import { describe, it, expect } from 'vitest';
import { resolveBindingFilters, dataCacheKey } from './resolveBinding';
import type { Binding, DataBinding } from './resolveBinding.types';

/**
 * `match` and `search` on a records binding: part of the cache key only when set (every other key
 * stays what it was), and a search value that is a formula is made literal before the fetch. A
 * search that holds no text is left out, so an empty search box shows every row.
 */

const SCOPE = { vars: { filters: { q: 'ann' }, blank: '', none: null, n: 7 } };
const q = (expr: string) => ({ kind: 'formula', expr });
const records = (extra: object): Binding => ({ kind: 'records', tableId: 't1', ...extra } as Binding);

describe('match and search in the cache key', () => {
    it('leaves a binding without them on the key it always had', () => {
        expect(dataCacheKey(records({ filter: [{ field: 'a', op: 'eq', value: 1 }] }))).toBe(
            'records:t1:{"filter":[{"field":"a","op":"eq","value":1}],"limit":null,"sort":null}',
        );
    });

    it('splits the key by match and by search', () => {
        const plain = dataCacheKey(records({}));
        const any = dataCacheKey(records({ match: 'any' }));
        const searched = dataCacheKey(records({ search: { value: 'x', fields: ['a'] } }));
        expect(new Set([plain, any, searched]).size).toBe(3);
    });

    it('keys an aggregate by match but never by a search it ignores', () => {
        const plain = dataCacheKey({ kind: 'aggregate', tableId: 't1' } as Binding);
        expect(dataCacheKey({ kind: 'aggregate', tableId: 't1', match: 'any' } as Binding)).not.toBe(plain);
        expect(dataCacheKey({ kind: 'aggregate', tableId: 't1', search: { value: 'x', fields: ['a'] } } as Binding)).toBe(plain);
    });
});

describe('resolveBindingFilters with a search', () => {
    it('makes a formula value literal', () => {
        const out = resolveBindingFilters(records({ search: { value: q('vars.filters.q'), fields: ['a', 'b'] } }), SCOPE) as DataBinding;
        expect(out.search).toEqual({ value: 'ann', fields: ['a', 'b'] });
    });

    it('spells a number out as text', () => {
        const out = resolveBindingFilters(records({ search: { value: q('vars.n'), fields: ['a'] } }), SCOPE) as DataBinding;
        expect(out.search?.value).toBe('7');
    });

    it('leaves the search out when the box is empty, blank or unset', () => {
        for (const expr of ['vars.blank', 'vars.none', 'vars.missing']) {
            const out = resolveBindingFilters(records({ match: 'any', search: { value: q(expr), fields: ['a'] } }), SCOPE) as DataBinding;
            expect('search' in out).toBe(false);
            expect(out.match).toBe('any');
        }
    });

    it('keeps a literal search, and a binding without one, as the same object', () => {
        const literal = records({ search: { value: 'fixed', fields: ['a'] } });
        expect(resolveBindingFilters(literal, SCOPE)).toBe(literal);
        const plain = records({ filter: [{ field: 'a', op: 'eq', value: 1 }] });
        expect(resolveBindingFilters(plain, SCOPE)).toBe(plain);
    });

    it('resolves the filters and the search together', () => {
        const out = resolveBindingFilters(records({
            filter: [{ field: 'a', op: 'eq', value: q('vars.filters.q') }],
            search: { value: q('vars.filters.q'), fields: ['a'] },
        }), SCOPE) as DataBinding;
        expect(out.filter).toEqual([{ field: 'a', op: 'eq', value: 'ann' }]);
        expect(out.search?.value).toBe('ann');
    });
});
