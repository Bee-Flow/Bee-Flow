import { AreaChart, BarChart, LineChart, PieChart, ReferenceArea, ReferenceLine } from 'recharts';
import { describe, expect, it } from 'vitest';
import { chartFitOf } from './AppChart';
import { chartPlot, chartReferences, type PlotArgs } from './AppChartPlots';

const args = (over: Partial<PlotArgs> = {}): PlotArgs => ({
    chartType: 'bar', horizontal: false, width: 300, height: 200, data: [{ label: 'a', v: 1 }], xKey: 'label',
    series: [{ key: 'v' }], palette: null, animate: false, stacked: false, clickable: false, chartClick: undefined,
    emitRow: () => {}, fmt: (v) => String(v), valueDomain: ['auto', 'auto'], barSize: undefined,
    parts: { xAxis: null, yAxis: null, grid: null, references: null, tooltip: null, legend: null },
    ...over,
});

describe('chartPlot', () => {
    it('picks the recharts chart for the type', () => {
        expect(chartPlot(args({ chartType: 'pie' })).type).toBe(PieChart);
        expect(chartPlot(args({ chartType: 'donut' })).type).toBe(PieChart);
        expect(chartPlot(args({ chartType: 'line' })).type).toBe(LineChart);
        expect(chartPlot(args({ chartType: 'area' })).type).toBe(AreaChart);
        expect(chartPlot(args()).type).toBe(BarChart);
    });

    it('lays a horizontal bar chart down', () => {
        const el = chartPlot(args({ horizontal: true }));
        expect(el.type).toBe(BarChart);
        expect(el.props.layout).toBe('vertical');
    });
});

describe('chartReferences', () => {
    it('is null without marks', () => {
        expect(chartReferences({ bands: [], lines: [], horizontal: false, pinned: false })).toBeNull();
    });

    it('puts bands before lines and clips only on a pinned axis', () => {
        const free = chartReferences({ bands: [{ from: 1, to: 2 }], lines: [{ value: 3 }], horizontal: false, pinned: false }) ?? [];
        expect(free.map((el) => el.type)).toEqual([ReferenceArea, ReferenceLine]);
        expect(free[0].props.ifOverflow).toBe('extendDomain');
        expect(free[1].props.y).toBe(3);
        const pinned = chartReferences({ bands: [], lines: [{ value: 3 }], horizontal: true, pinned: true }) ?? [];
        expect(pinned[0].props.ifOverflow).toBe('hidden');
        expect(pinned[0].props.x).toBe(3);
    });
});

describe('chartFitOf', () => {
    it('keeps a fixed box without a height', () => {
        expect(chartFitOf(false, '', 'Title', 0)).toEqual({ fitted: false, height: 200 });
        expect(chartFitOf(false, 'auto', null, 500)).toEqual({ fitted: false, height: 200 });
    });

    it('fits a sized or filling chart to the measured room', () => {
        expect(chartFitOf(false, 'lg', null, 0)).toEqual({ fitted: true, height: 320 });
        expect(chartFitOf(false, 'lg', 'Title', 0)).toEqual({ fitted: true, height: 292 });
        expect(chartFitOf(true, 'fill', null, 410)).toEqual({ fitted: true, height: 410 });
    });
});
