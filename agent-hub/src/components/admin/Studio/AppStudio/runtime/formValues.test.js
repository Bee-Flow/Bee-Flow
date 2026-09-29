// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mergeFormValues } from './formValues';

describe('mergeFormValues', () => {
    it('folds a form into the forms root', () => {
        expect(mergeFormValues({}, 'std', { a: 1 })).toEqual({ std: { a: 1 } });
        expect(mergeFormValues({ other: { x: 1 } }, 'std', { a: 1 }))
            .toEqual({ other: { x: 1 }, std: { a: 1 } });
    });

    it('returns the SAME object when the values are unchanged', () => {
        // The point of the guard: a new `forms` identity re-memos buildScope,
        // which re-renders every bound component on the screen. Re-publishing
        // identical values has to be free.
        const prev = { std: { a: 1, b: null } };
        expect(mergeFormValues(prev, 'std', { a: 1, b: null })).toBe(prev);
        expect(mergeFormValues(prev, 'std', prev.std)).toBe(prev);
    });

    it('allocates when anything actually moved', () => {
        const prev = { std: { a: 1, b: null } };
        expect(mergeFormValues(prev, 'std', { a: 2, b: null })).not.toBe(prev);
        expect(mergeFormValues(prev, 'std', { a: 1 })).not.toBe(prev);            // key removed
        expect(mergeFormValues(prev, 'std', { a: 1, b: null, c: 3 })).not.toBe(prev); // key added
        expect(mergeFormValues(prev, 'other', {})).not.toBe(prev);                // new form
    });

    it('compares by identity, not by depth', () => {
        // Form values are flat name → scalar maps; a nested object that is a new
        // reference counts as a change rather than being walked.
        const prev = { std: { pick: { id: 1 } } };
        expect(mergeFormValues(prev, 'std', { pick: { id: 1 } })).not.toBe(prev);
        expect(mergeFormValues(prev, 'std', { pick: prev.std.pick })).toBe(prev);
    });

    it('is inert without a form name, and treats a null payload as empty', () => {
        const prev = { std: { a: 1 } };
        expect(mergeFormValues(prev, '', { a: 2 })).toBe(prev);
        expect(mergeFormValues(prev, null, { a: 2 })).toBe(prev);
        expect(mergeFormValues(prev, 'std', null)).toEqual({ std: {} });
        expect(mergeFormValues(undefined, 'std', undefined)).toEqual({ std: {} });
        // …and an already-empty form publishing empty again is still free.
        const empty = { std: {} };
        expect(mergeFormValues(empty, 'std', null)).toBe(empty);
    });
});
