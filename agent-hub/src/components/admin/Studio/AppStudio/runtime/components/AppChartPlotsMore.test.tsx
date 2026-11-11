import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/test/appScreenRender';
import { scatterPoints } from './AppChartPlotsMore';

const ROWS = [
    { label: 'Visits', weight: 1, count: 120, rate: 0.4 },
    { label: 'Leads', weight: 2, count: 60, rate: 0.3 },
    { label: 'Deals', weight: 3, count: 12, rate: 0.2 },
];

const chart = (props: Record<string, unknown>) => ({
    id: 'cmp_chart', type: 'chart', visible: true, style: { span: 12, height: 'md' },
    props: { source: { kind: 'static', value: ROWS }, xKey: 'label', ...props },
});

const drawn = (props: Record<string, unknown>) => renderScreen([chart(props)]).container;

describe('chart kinds of schema 3', () => {
    it('combo draws each series as its own type, with a second value axis on request', () => {
        const c = drawn({ chartType: 'combo', series: [{ key: 'count', type: 'bar' }, { key: 'rate', type: 'line', yAxis: 'right' }] });
        expect(c.querySelector('[data-app-chart="combo"] svg.recharts-surface')).toBeTruthy();
        expect(c.querySelectorAll('.recharts-bar').length).toBeGreaterThan(0);
        expect(c.querySelectorAll('.recharts-line').length).toBeGreaterThan(0);
        expect(c.querySelectorAll('.recharts-yAxis').length).toBe(2);
    });

    it('scatter, funnel and radar draw their own plot', () => {
        expect(drawn({ chartType: 'scatter', xKey: 'weight', series: [{ key: 'count' }] }).querySelector('.recharts-scatter')).toBeTruthy();
        expect(drawn({ chartType: 'funnel', series: [{ key: 'count' }] }).querySelector('.recharts-funnel-trapezoids, .recharts-trapezoids')).toBeTruthy();
        expect(drawn({ chartType: 'radar', series: [{ key: 'count' }, { key: 'weight' }] }).querySelectorAll('.recharts-radar').length).toBe(2);
    });

    it('a scatter point needs a number on both axes', () => {
        const points = scatterPoints([{ x: 1, y: '2' }, { x: 'a', y: 3 }, { x: 4, y: null }], 'x', 'y');
        expect(points.map((p) => [p.x, p.y])).toEqual([[1, 2]]);
    });
});
