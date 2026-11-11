import { describe, expect, it } from 'vitest';
import { dataCacheKey } from './resolveBinding';
import type { DataBinding } from './resolveBinding.types';

/**
 * An aggregate binding's `groupFilter` joins the cache key only when it is
 * there, so an aggregate without one keeps the key it always had (the server
 * render port in services/appStudioRender.js builds the same key).
 */

describe('dataCacheKey with groupFilter', () => {
    const base: DataBinding = { kind: 'aggregate', tableId: 'tbl_a', groupBy: [{ field: 'customer', relatedField: 'region' }], aggregates: [{ fn: 'countDistinct', field: 'customer', as: 'n' }] };

    it('is the plain aggregate key without one', () => {
        expect(dataCacheKey(base)).toBe('aggregate:tbl_a:{"aggregates":[{"as":"n","field":"customer","fn":"countDistinct"}],"filter":null,"groupBy":[{"field":"customer","relatedField":"region"}],"limit":null,"sort":null}');
        expect(dataCacheKey({ ...base, groupFilter: null })).toBe(dataCacheKey(base));
    });

    it('differs per groupFilter', () => {
        const a = dataCacheKey({ ...base, groupFilter: [{ field: 'n', op: 'gt', value: 1 }] });
        const b = dataCacheKey({ ...base, groupFilter: [{ field: 'n', op: 'gt', value: 2 }] });
        expect(a).toContain('"groupFilter":[');
        expect(a).not.toBe(b);
        expect(a).not.toBe(dataCacheKey(base));
    });
});
