import { describe, expect, test } from 'vitest';
import { formatChartNumber, formatDelta, valueLabelPosition } from './sheetChartFormat';

describe('sheetChartFormat', () => {
    test('compact axis numbers and full tooltip numbers', () => {
        expect(formatChartNumber(160000, {}, 'en', true)).toBe('160K');
        expect(formatChartNumber(1200000, {}, 'en', true)).toBe('1.2M');
        expect(formatChartNumber(1234.5, {}, 'en')).toBe('1,234.5');
        expect(formatChartNumber(1234.5, {}, 'nl')).toBe('1.234,5');
    });

    test('currency defaults to EUR; percent multiplies', () => {
        expect(formatChartNumber(1234, { format: 'currency' }, 'en')).toBe('€1,234.00');
        expect(formatChartNumber(1234, { format: 'currency', currency: 'USD' }, 'en')).toBe('$1,234.00');
        expect(formatChartNumber(0.262, { format: 'percent' }, 'en')).toBe('26.2%');
        expect(formatChartNumber(0.262, { format: 'percent' }, 'en', true)).toBe('26%');
    });

    test('a bad currency code falls back to the plain number; the delta carries its sign', () => {
        expect(formatChartNumber(5, { format: 'currency', currency: 'nope' }, 'en')).toBe('5');
        expect(formatDelta(0.123, 'en')).toBe('+12.3%');
        expect(formatDelta(-0.05, 'en')).toBe('-5%');
    });

    test('data labels sit beside a horizontal bar, inside a stacked segment, else on top', () => {
        expect(valueLabelPosition('hbar')).toBe('right');
        expect(valueLabelPosition('stacked')).toBe('center');
        expect(valueLabelPosition('bar')).toBe('top');
        expect(valueLabelPosition('line')).toBe('top');
    });
});
