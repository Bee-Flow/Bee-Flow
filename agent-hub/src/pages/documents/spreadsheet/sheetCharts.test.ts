import { describe, expect, test } from 'vitest';
import { chartDataFrom, parseA1Range, validateChart } from './sheetCharts';
import { evaluateSheet } from './sheetEngine';

describe('sheetCharts', () => {
    test('parseA1Range handles cells and ranges', () => {
        expect(parseA1Range('A1')).toEqual({ c1: 0, r1: 0, c2: 0, r2: 0 });
        expect(parseA1Range('B2:D9')).toEqual({ c1: 1, r1: 1, c2: 3, r2: 8 });
        expect(parseA1Range('nope')).toBeNull();
    });

    test('chartDataFrom extracts numeric values and labels', () => {
        const cells = { A2: 'Jan', B2: '10', A3: 'Feb', B3: '20' };
        const computed = evaluateSheet(cells);
        const config = { id: 'c1', type: 'bar' as const, dataRange: 'B2:B3', categoriesRange: 'A2:A3', anchor: 'D2', width: 100, height: 100 };
        expect(chartDataFrom(config, computed)).toEqual([
            { label: 'Jan', value: 10, display: '10' },
            { label: 'Feb', value: 20, display: '20' },
        ]);
    });

    test('chartDataFrom skips non-numeric values', () => {
        const computed = evaluateSheet({ B2: 'x', B3: '5' });
        const config = { id: 'c1', type: 'bar' as const, dataRange: 'B2:B3', anchor: 'D2', width: 100, height: 100 };
        expect(chartDataFrom(config, computed)).toEqual([{ label: '2', value: 5, display: '5' }]);
    });

    test('validateChart catches missing fields', () => {
        expect(validateChart({})).toBeTruthy();
        expect(validateChart({ id: 'c', type: 'bar', dataRange: 'A1:A2', anchor: 'D2', width: 100, height: 100 })).toBeNull();
        expect(validateChart({ id: 'c', type: 'donut', dataRange: 'A1:A2', anchor: 'D2', width: 100, height: 100 })).toBeTruthy();
    });
});
