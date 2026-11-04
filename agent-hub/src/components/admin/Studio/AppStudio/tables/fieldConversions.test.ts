import { describe, expect, it } from 'vitest';
import { blockedConversions, safeTargetTypes } from './fieldConversions';

describe('fieldConversions', () => {
    it('offers the field its own type first, then the in-place conversions', () => {
        expect(safeTargetTypes('text')).toEqual(['text', 'select', 'number']);
        expect(safeTargetTypes('select')).toEqual(['select', 'text']);
        expect(safeTargetTypes('number')).toEqual(['number', 'text']);
        expect(safeTargetTypes('date')).toEqual(['date']);
        expect(safeTargetTypes(undefined)).toEqual(['text', 'select', 'number']);
    });

    it('keeps only the conversions that hold values the new type cannot store', () => {
        expect(blockedConversions([{ field: 'a', unconvertible: 0 }, { field: 'b', unconvertible: 3 }, { field: 'c', unconvertible: null }])).toEqual([{ field: 'b', unconvertible: 3 }]);
        expect(blockedConversions(null)).toEqual([]);
    });
});
