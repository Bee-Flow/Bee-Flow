import { describe, expect, it } from 'vitest';
import { dataCacheKey } from './resolveBinding';
import type { DataBinding } from './resolveBinding.types';

/**
 * A record read's `expand` and `fields` join the cache key only when they are
 * there, so a binding without them keeps the key it always had (the server
 * render port in services/appStudioRender.js and the phone build the same key).
 */

describe('dataCacheKey with expand and fields', () => {
    const base: DataBinding = { kind: 'records', tableId: 'tbl_a', filter: [{ field: 'customer.region', op: 'eq', value: 'north' }] };

    it('is the plain records key without them', () => {
        expect(dataCacheKey(base)).toBe('records:tbl_a:{"filter":[{"field":"customer.region","op":"eq","value":"north"}],"limit":null,"sort":null}');
        expect(dataCacheKey({ ...base, expand: null, fields: undefined })).toBe(dataCacheKey(base));
    });

    it('differs per expand and per fields, for record and records alike', () => {
        const expanded = dataCacheKey({ ...base, expand: [{ field: 'customer', pick: ['name'] }] });
        const other = dataCacheKey({ ...base, expand: [{ field: 'customer', pick: ['city'] }] });
        const narrowed = dataCacheKey({ ...base, fields: ['title'] });
        expect(expanded).toContain('"expand":[');
        expect(narrowed).toContain('"fields":["title"]');
        expect(new Set([dataCacheKey(base), expanded, other, narrowed]).size).toBe(4);
        expect(dataCacheKey({ ...base, kind: 'record', fields: ['title'] })).toContain('"fields":["title"]');
        // The same string services/appStudioRender.js builds (core/dataEngine/aggregateRelated.test.js pins it there).
        expect(dataCacheKey({ ...base, expand: [{ field: 'customer', pick: ['name'] }], fields: ['title'] }))
            .toBe('records:tbl_a:{"expand":[{"field":"customer","pick":["name"]}],"fields":["title"],"filter":[{"field":"customer.region","op":"eq","value":"north"}],"limit":null,"sort":null}');
    });
});
