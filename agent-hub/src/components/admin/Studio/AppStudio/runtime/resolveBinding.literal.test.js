import { describe, it, expect } from 'vitest';
import { resolveBinding } from './resolveBinding';

/**
 * `computed` is documented to work on EVERY prop of every component — it is the
 * escape hatch the guide points authors at when a prop has no binding of its
 * own. But it evaluates to a plain value, and a plain value handed to a
 * BINDING-typed prop (progress.value, stat.value, chart.source) used to be
 * dropped on the floor: a progress bar with a computed count rendered "0 / 7"
 * with seven files attached, and nothing anywhere said why.
 */
describe('resolveBinding — a bare value is its own value', () => {
    it('resolves a computed number, which is what a progress bar receives', () => {
        expect(resolveBinding(7, {}).value).toBe(7);
    });

    it('resolves zero and empty string rather than treating them as absent', () => {
        expect(resolveBinding(0, {}).value).toBe(0);
        expect(resolveBinding('', {}).value).toBe('');
    });

    it('resolves a bare string and boolean', () => {
        expect(resolveBinding('Klaar', {}).value).toBe('Klaar');
        expect(resolveBinding(false, {}).value).toBe(false);
    });

    it('still reports nothing for null and undefined', () => {
        expect(resolveBinding(null, {}).value).toBeUndefined();
        expect(resolveBinding(undefined, {}).value).toBeUndefined();
    });

    // The rescue is for LITERALS. A malformed binding is still a bug and must
    // not start rendering "[object Object]" at the user.
    it('an object with no recognised kind still resolves to nothing', () => {
        expect(resolveBinding({ tableId: 'tbl_1' }, {}).value).toBeUndefined();
        expect(resolveBinding({ kind: 'nonsense' }, {}).value).toBeUndefined();
    });

    it('a real binding is unaffected', () => {
        expect(resolveBinding({ kind: 'static', value: 42 }, {}).value).toBe(42);
        expect(resolveBinding({ kind: 'formula', expr: '1 + 1' }, {}).value).toBe(2);
    });
});
