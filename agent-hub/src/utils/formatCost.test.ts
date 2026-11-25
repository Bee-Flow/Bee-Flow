// @vitest-environment node
// What AI work cost, as Cowork says it: one precision everywhere, and "< €0.01" for less than a cent.
import { describe, expect, it } from 'vitest';
import { formatCost, formatCostCents } from './formatCost';

describe('formatCostCents', () => {
    it('always shows two decimals, so "€0.004" never stands next to "€0.04"', () => {
        expect(formatCostCents({ EUR: 0.04 })).toBe('€0.04');
        expect(formatCostCents({ EUR: 3.1 })).toBe('€3.10');
        expect(formatCostCents({ EUR: 0.045 })).toMatch(/^€0\.0[45]$/);
    });

    it('says "< €0.01" for anything above zero and below a cent, and €0.00 for nothing', () => {
        expect(formatCostCents({ EUR: 0.004 })).toBe('< €0.01');
        expect(formatCostCents({ EUR: 0.0001 })).toBe('< €0.01');
        expect(formatCostCents({ EUR: 0 })).toBe('€0.00');
    });

    it('formats in the reader\'s locale, one amount per currency, and a dash without a priced call', () => {
        expect(formatCostCents({ EUR: 0.62 }, 'nl')).toMatch(/0,62/);
        expect(formatCostCents({ EUR: 0.5, USD: 0.002 })).toBe('€0.50 · < $0.01');
        expect(formatCostCents({})).toBe('—');
        expect(formatCostCents(null)).toBe('—');
    });

    it('leaves the finer formatter of the App Studio run views as it was', () => {
        expect(formatCost({ EUR: 0.0021 })).toBe('€0.0021');
    });
});
