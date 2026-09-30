import { _reset, setCatalogue } from '@/core/i18n';

import { buildChart, type ArcChart, type CartesianChart } from './chartModel';
import { niceDomain, formatNumber, formatDate, toTime } from './scales';
import { readChartSource } from './vegaSpec';

const PALETTE = ['#c1', '#c2', '#c3', '#c4'];

function model(spec: object) {
    const chart = readChartSource(JSON.stringify(spec));
    if (!chart) throw new Error('unreadable');
    return buildChart(chart, PALETTE);
}

const SALES = [
    { month: 'Feb', region: 'North', sales: 20 },
    { month: 'Jan', region: 'North', sales: 10 },
    { month: 'Jan', region: 'South', sales: 5 },
    { month: 'Feb', region: 'South', sales: 15 },
];

describe('readChartSource', () => {
    it('refuses what is not a JSON object', () => {
        expect(readChartSource('{"mark":')).toBeNull();
        expect(readChartSource('[1,2]')).toBeNull();
    });

    it('reads titles, the field shorthand and an unknown mark', () => {
        const chart = readChartSource(
            JSON.stringify({ title: { text: 'T', subtitle: 'S' }, data: { values: [] }, mark: 'bar', encoding: { x: { field: 'a:N' } } }),
        );
        expect(chart).toMatchObject({ title: 'T', subtitle: 'S', unsupported: null });
        expect(chart?.layers[0]?.encoding.x).toMatchObject({ field: 'a', type: 'nominal' });
        expect(readChartSource(JSON.stringify({ data: { values: [] }, mark: 'rule' }))?.unsupported).toBe('mark rule');
    });

    it('marks what the phone does not draw', () => {
        const base = { data: { values: [{ a: 1 }] }, mark: 'bar' };
        expect(readChartSource(JSON.stringify({ ...base, transform: [] }))?.unsupported).toBe('transform');
        expect(readChartSource(JSON.stringify({ mark: 'bar', data: { url: 'x.csv' } }))?.unsupported).toBe('data');
        expect(readChartSource(JSON.stringify({ ...base, encoding: { x: { field: 'a', bin: true } } }))?.unsupported).toBe('bin');
        expect(readChartSource(JSON.stringify({ ...base, mark: 'constructor' }))?.unsupported).toBe('mark constructor');
    });
});

describe('buildChart', () => {
    it('draws a simple bar chart on sorted categories', () => {
        const chart = model({
            data: { values: [{ c: 'B', v: 5 }, { c: 'A', v: 3 }] },
            mark: 'bar',
            encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
        }) as CartesianChart;
        expect(chart.kind).toBe('cartesian');
        expect(chart.horizontal).toBe(false);
        expect(chart.dimension).toMatchObject({ scale: 'band', categories: ['A', 'B'] });
        expect(chart.measure.domain).toEqual([0, 5]);
        expect(chart.layers[0]?.series[0]).toMatchObject({ color: '#c1' });
        expect(chart.legend).toEqual([]);
    });

    it('stacks bars by colour, with sorted series and a legend', () => {
        const chart = model({
            data: { values: SALES },
            mark: 'bar',
            encoding: { x: { field: 'month', sort: null }, y: { field: 'sales', type: 'quantitative' }, color: { field: 'region' } },
        }) as CartesianChart;
        expect(chart.dimension).toMatchObject({ categories: ['Feb', 'Jan'] });
        expect(chart.legend.map((l) => l.label)).toEqual(['North', 'South']);
        const south = chart.layers[0]?.series[1]?.points.find((p) => p.key === 'Feb');
        expect(south).toMatchObject({ base: 20, value: 35 });
        expect(chart.measure.domain[1]).toBeGreaterThanOrEqual(35);
        expect(chart.grouped).toBe(false);
    });

    it('groups bars with an xOffset, and normalises a stack to 100%', () => {
        const grouped = model({
            data: { values: SALES },
            mark: 'bar',
            encoding: { x: { field: 'month' }, xOffset: { field: 'region' }, y: { field: 'sales' }, color: { field: 'region' } },
        }) as CartesianChart;
        expect(grouped.grouped).toBe(true);
        const normal = model({
            data: { values: SALES },
            mark: 'area',
            encoding: { x: { field: 'month' }, y: { field: 'sales', stack: 'normalize' }, color: { field: 'region' } },
        }) as CartesianChart;
        expect(normal.measure.percent).toBe(true);
        expect(normal.measure.domain).toEqual([0, 1]);
    });

    it('turns a quantitative x over a nominal y into horizontal bars', () => {
        const chart = model({
            data: { values: [{ name: 'a', n: 2 }, { name: 'b', n: 9 }] },
            mark: 'bar',
            encoding: { y: { field: 'name', type: 'nominal', sort: '-x' }, x: { field: 'n', type: 'quantitative' } },
        }) as CartesianChart;
        expect(chart.horizontal).toBe(true);
        expect(chart.dimension).toMatchObject({ categories: ['b', 'a'] });
    });

    it('aggregates: a count, and a sum by default for bars', () => {
        const chart = model({
            data: { values: [{ k: 'x' }, { k: 'x' }, { k: 'y' }] },
            mark: 'bar',
            encoding: { x: { field: 'k' }, y: { aggregate: 'count' } },
        }) as CartesianChart;
        expect(chart.layers[0]?.series[0]?.points.map((p) => [p.key, p.value])).toEqual([['x', 2], ['y', 1]]);
        expect(chart.measureTitle).toBe('Count of Records');
    });

    it('puts a line over dates on a time axis', () => {
        const chart = model({
            data: { values: [{ d: '2024-01-01', v: 1 }, { d: '2024-03-01', v: 4 }] },
            mark: { type: 'line', point: true },
            encoding: { x: { field: 'd', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } },
        }) as CartesianChart;
        expect(chart.dimension.scale).toBe('time');
        expect(chart.layers[0]?.showPoints).toBe(true);
        expect(chart.layers[0]?.series[0]?.points[0]?.at).toBe(Date.parse('2024-01-01'));
    });

    it('draws layers of the same data together', () => {
        const chart = model({
            data: { values: [{ x: 1, y: 2 }, { x: 2, y: 3 }] },
            encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } },
            layer: [{ mark: 'line' }, { mark: 'point' }],
        }) as CartesianChart;
        expect(chart.layers.map((l) => l.mark)).toEqual(['line', 'point']);
        expect(chart.dimension.scale).toBe('linear');
    });

    it('makes a pie or a donut from theta and colour', () => {
        const chart = model({
            data: { values: [{ k: 'b', v: 1 }, { k: 'a', v: 3 }, { k: 'b', v: 2 }] },
            mark: { type: 'arc', innerRadius: 40 },
            encoding: { theta: { field: 'v', type: 'quantitative' }, color: { field: 'k', type: 'nominal' } },
        }) as ArcChart;
        expect(chart.kind).toBe('arc');
        expect(chart.innerRadius).toBe(40);
        expect(chart.slices.map((s) => [s.label, s.value])).toEqual([['a', 3], ['b', 3]]);
    });

    it('falls back to the data table for what it cannot draw', () => {
        expect(model({ data: { values: [{ a: 'x', b: 'y' }] }, mark: 'bar', encoding: { x: { field: 'a' }, y: { field: 'b' } } })).toEqual({
            kind: 'table',
            reason: 'no measure axis',
        });
        expect(model({ data: { values: [{ a: 1 }] }, mark: 'bar', transform: [{ filter: 'x' }] })).toMatchObject({ kind: 'table' });
    });
});

describe('scales', () => {
    it('picks round ticks that cover the data', () => {
        expect(niceDomain(0, 87)).toEqual({ domain: [0, 100], ticks: [0, 20, 40, 60, 80, 100] });
        expect(niceDomain(-3, 12).domain).toEqual([-5, 15]);
        expect(niceDomain(5, 5).ticks.length).toBeGreaterThan(1);
    });

    it('labels numbers and dates briefly', () => {
        expect(formatNumber(1234)).toBe('1,234');
        expect(formatNumber(25_000)).toBe('25k');
        expect(formatNumber(3_400_000)).toBe('3.4M');
        expect(formatDate(Date.UTC(2024, 2, 5), 10 * 86_400_000)).toBe('Mar 5');
        expect(formatDate(Date.UTC(2024, 2, 5), 5 * 365 * 86_400_000)).toBe('2024');
        expect(formatDate(Date.UTC(2024, 2, 5), 200 * 86_400_000)).toBe('Mar 24');
        expect(toTime('2021')).toBe(Date.UTC(2021, 0, 1));
        expect(toTime('soon')).toBeNull();
    });

    it('labels them in the app’s language, not in American English', () => {
        // A Dutch chart read "2,500" (a Dutch reader's two and a half) and "Mar".
        setCatalogue('nl', {});
        try {
            expect(formatNumber(2500)).toBe('2.500');
            expect(formatNumber(2.25)).toBe('2,25');
            expect(formatNumber(3_400_000)).toBe('3,4M');
            expect(formatDate(Date.UTC(2024, 2, 5), 10 * 86_400_000)).toBe('5 mrt');
            expect(formatDate(Date.UTC(2024, 2, 5), 200 * 86_400_000)).toMatch(/^mrt '?24$/);
        } finally {
            _reset();
        }
    });
});
