import { describe, expect, it } from 'vitest';
import { isLoneRef, translateForMode } from './bindingFieldModel';

describe('isLoneRef', () => {
    it('sees one reference, bare or in the call a picked list is written as', () => {
        expect(isLoneRef('steps.a.output.x', 'expression')).toBe(true);
        expect(isLoneRef('first(steps.a.output.items)', 'expression')).toBe(true);
        expect(isLoneRef(' join( steps.a.output.items , "\\n" ) ', 'expression')).toBe(true);
        expect(isLoneRef("join(steps.a.output.items, ', ')", 'expression')).toBe(true);
        expect(isLoneRef('  {{ steps.a.output.x }} ', 'fixed')).toBe(true);
    });

    it('does not see one in a computed expression, a mixed text or an empty {{ }}', () => {
        expect(isLoneRef('join(steps.a.output.items, sep)', 'expression')).toBe(false);
        expect(isLoneRef('first(steps.a.output.items))', 'expression')).toBe(false);
        expect(isLoneRef('{{ steps.a.output.x }} and more', 'fixed')).toBe(false);
        expect(isLoneRef('{{ }}', 'fixed')).toBe(false);
    });

    it('answers at once on a long run of spaces (the regexes backtracked for seconds)', () => {
        const spaces = ' '.repeat(5000);
        const start = performance.now();
        expect(isLoneRef(`first(${spaces}x`, 'expression')).toBe(false);
        expect(isLoneRef(`join(a${spaces},"x"${spaces}`, 'expression')).toBe(false);
        expect(isLoneRef(`{{${spaces}x`, 'fixed')).toBe(false);
        expect(translateForMode(`{{${spaces}x`, 'expression')).toBe(`{{${spaces}x`);
        expect(performance.now() - start).toBeLessThan(500);
    });
});

describe('translateForMode', () => {
    it('unwraps a lone {{ }} for Formula mode and leaves anything else', () => {
        expect(translateForMode('{{ steps.a.output.x }}', 'expression')).toBe('steps.a.output.x');
        expect(translateForMode('{{a}} {{b}}', 'expression')).toBe('{{a}} {{b}}');
        expect(translateForMode('{{ }}', 'expression')).toBe('{{ }}');
    });
});
