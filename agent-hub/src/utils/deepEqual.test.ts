import { describe, expect, it } from 'vitest';
import { deepEqual } from './deepEqual';

describe('deepEqual', () => {
    it('ignores key order', () => {
        expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    });

    it('tells an array from an object with the same keys', () => {
        expect(deepEqual([1], { 0: 1 })).toBe(false);
    });

    it('sees a different key when the counts match and a value is undefined', () => {
        // A form that cleared one field (undefined) and dropped another has the
        // same number of keys as its snapshot, and every key it does have reads
        // `undefined` on the other side as well.
        expect(deepEqual({ timeout: undefined }, { retries: 3 })).toBe(false);
        expect(deepEqual({ a: 1, timeout: undefined }, { a: 1, retries: 3 })).toBe(false);
    });
});
