import { describe, it, expect } from 'vitest';
import { resolveBinding, dataCacheKey } from './resolveBinding';

// A `record` binding answers with ONE row. `path` names a field inside it, so a
// scalar consumer — a page_header title, a computed prop — can show that field
// instead of the whole row object.
const ROW = { id: 'rec_1', klantnaam: 'J. van der Meer', plaats: 'Leiden', maten: { hoogte: 210 } };

function stateFor(binding, entry) {
    return { dataState: { [dataCacheKey(binding)]: entry } };
}

describe('resolveBinding — path on a record binding', () => {
    const base = { kind: 'record', tableId: 'tbl_1' };
    const loaded = { status: 'success', result: ROW, tableId: 'tbl_1' };

    it('without a path the record still resolves to the whole row', () => {
        expect(resolveBinding(base, stateFor(base, loaded)).value).toEqual(ROW);
    });

    it('a path resolves to that field of the row', () => {
        const bound = { ...base, path: 'klantnaam' };
        expect(resolveBinding(bound, stateFor(base, loaded)).value).toBe('J. van der Meer');
    });

    it('a dotted path walks into a nested value', () => {
        const bound = { ...base, path: 'maten.hoogte' };
        expect(resolveBinding(bound, stateFor(base, loaded)).value).toBe(210);
    });

    it('a path that is not in the row resolves to undefined, never throws', () => {
        const bound = { ...base, path: 'bestaatniet' };
        expect(resolveBinding(bound, stateFor(base, loaded)).value).toBeUndefined();
    });

    // The path is a read-side projection, not part of the query: two headers
    // reading different fields of the same row must share ONE fetch.
    it('the path stays out of the cache key', () => {
        expect(dataCacheKey({ ...base, path: 'klantnaam' })).toBe(dataCacheKey(base));
    });

    // `records` is a LIST — a bare path there would be ambiguous, and `pick` is
    // the documented way to reduce a row array to one value.
    it('a path on a records binding is ignored', () => {
        const list = { kind: 'records', tableId: 'tbl_1' };
        const rows = { status: 'success', result: [ROW], tableId: 'tbl_1' };
        const bound = { ...list, path: 'klantnaam' };
        expect(resolveBinding(bound, stateFor(list, rows)).value).toEqual([ROW]);
    });

    it('loading and error states pass through untouched', () => {
        const bound = { ...base, path: 'klantnaam' };
        expect(resolveBinding(bound, stateFor(base, { status: 'loading' })).isLoading).toBe(true);
        expect(resolveBinding(bound, stateFor(base, { status: 'error', error: 'boom' })).error).toBe('boom');
    });
});
