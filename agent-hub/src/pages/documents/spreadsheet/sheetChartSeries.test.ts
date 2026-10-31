// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { chartRows, chartSeriesFrom, kpiFrom, scatterPoints } from './sheetChartSeries';
import { CHART_PALETTE, CHART_TYPES, chartColor, validateChart, type SheetChartConfig } from './sheetCharts';
import { evaluateSheet } from './sheetEngine';

const cells = {
    A1: 'Month', B1: 'Sales', C1: 'Costs', D1: '7',
    A2: 'Jan', B2: '10', C2: '4', D2: '1',
    A3: 'Feb', B3: '20', C3: '6', D3: '2',
    A4: 'Mar', B4: 'x', C4: '', D4: '3',
    F1: '100', F2: '80',
};
const computed = evaluateSheet(cells);
const base = { id: 'c', type: 'bar', dataRange: 'B2:C4', categoriesRange: 'A2:A4', anchor: 'H2', width: 100, height: 100 } as SheetChartConfig;

describe('sheetChartSeries', () => {
    test('every data column is a series named by the text cell above it', () => {
        const data = chartSeriesFrom(base, computed);
        expect(data.series.map((s) => s.name)).toEqual(['Sales', 'Costs']);
        expect(data.series[0].values).toEqual([10, 20, null]);
        expect(data.categories).toEqual(['Jan', 'Feb', 'Mar']);
    });

    test('a column without a text header is named by its letter, and a numeric header does not count', () => {
        expect(chartSeriesFrom({ ...base, dataRange: 'D2:D3' }, computed).series[0].name).toBe('D');
        expect(chartSeriesFrom({ ...base, dataRange: 'B1:B1' }, computed).series[0].name).toBe('B');
    });

    test('pie and doughnut use the first column only', () => {
        expect(chartSeriesFrom({ ...base, type: 'pie' }, computed).series).toHaveLength(1);
        expect(chartSeriesFrom({ ...base, type: 'doughnut' }, computed).series).toHaveLength(1);
        expect(chartSeriesFrom({ ...base, type: 'stacked' }, computed).series).toHaveLength(2);
    });

    test('rows for recharts skip rows with no number; scatter pairs x with y', () => {
        const data = chartSeriesFrom(base, computed);
        expect(chartRows(data)).toEqual([{ label: 'Jan', s0: 10, s1: 4 }, { label: 'Feb', s0: 20, s1: 6 }]);
        const sc = chartSeriesFrom({ ...base, type: 'scatter', categoriesRange: 'D2:D4' }, computed);
        expect(scatterPoints(sc)[0]).toEqual({ name: 'Sales', points: [{ x: 1, y: 10 }, { x: 2, y: 20 }] });
    });

    test('kpi reads one cell and the change against compareRange', () => {
        const kpi = { ...base, type: 'kpi', dataRange: 'F1', compareRange: 'F2' } as SheetChartConfig;
        const out = kpiFrom(kpi, computed);
        expect(out.value).toBe(100);
        expect(out.delta).toBeCloseTo(0.25);
        expect(kpiFrom({ ...kpi, compareRange: undefined }, computed).delta).toBeNull();
    });

    test('types, palette and validation', () => {
        expect(CHART_TYPES).toEqual(['bar', 'hbar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'stacked', 'kpi']);
        expect(chartColor({}, 1)).toBe(CHART_PALETTE[1]);
        expect(chartColor({}, 9)).toBe(CHART_PALETTE[1]);
        expect(chartColor({ colors: ['#112233'] }, 3)).toBe('#112233');
        expect(validateChart({ ...base, type: 'scatter', categoriesRange: undefined })).toBeTruthy();
        expect(validateChart({ ...base, type: 'kpi' })).toBeTruthy();
        expect(validateChart({ ...base, type: 'kpi', dataRange: 'F1' })).toBeNull();
        expect(validateChart({ ...base, colors: ['red'] })).toBeTruthy();
        for (const type of CHART_TYPES.filter((t) => t !== 'scatter' && t !== 'kpi')) expect(validateChart({ ...base, type })).toBeNull();
    });
});
