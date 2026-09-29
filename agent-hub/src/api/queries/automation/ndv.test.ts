import { describe, expect, it } from 'vitest';
import { normaliseUsageValues } from './ndv';

describe('normaliseUsageValues — GET /_usage/values', () => {
    it('keeps plain values with a positive count, most used first, at most four', () => {
        const rows = [
            { value: 'Photos', count: 2 }, { value: 'Invoices', count: 9 }, { value: '', count: 5 },
            { value: { a: 1 }, count: 3 }, { value: 'Invoices', count: 1 }, { value: 'Docs', count: 0 },
            { value: 42, count: 4 }, { value: 'A', count: 1 }, { value: 'B', count: 1 },
        ];
        expect(normaliseUsageValues(rows)).toEqual([
            { value: 'Invoices', count: 9 }, { value: '42', count: 4 }, { value: 'Photos', count: 2 }, { value: 'A', count: 1 },
        ]);
    });

    it('reads a { values } envelope and treats anything else as no history', () => {
        expect(normaliseUsageValues({ values: [{ value: 'x', count: 1 }] })).toEqual([{ value: 'x', count: 1 }]);
        expect(normaliseUsageValues(null)).toEqual([]);
    });
});
