/**
 * The renderers' pure geometry: table columns, the zoom viewer's limits, chart
 * scales and shapes, flowchart layout and link curves, and entity decoding.
 */

import { decodeEntities } from '@/shared/markdown/parse/entities';

import { arcPath, bandScale, barRects, buildScales, linePath, sliceAngles, areaPath } from './chart/chartGeometry';
import { buildChart, type CartesianChart } from './chart/chartModel';
import { readChartSource } from './chart/vegaSpec';
import { basisPath, endMark, trimForEnd } from './mermaid/edgePath';
import { layoutFlowchart, nodeSize, wrapLabel } from './mermaid/flowchartLayout';
import { readFlowchart } from './mermaid/flowchartParser';
import { columnWidths, fillWidths, MAX_COLUMN, MIN_COLUMN } from './table/tableLayout';
import { clampOffset, clampScale } from './viewer/zoomMath';

describe('tables', () => {
    it('sizes columns from their longest line, within bounds', () => {
        const widths = columnWidths(['Name', 'Notes'], [['Al', 'x'.repeat(200)], ['Bo', 'short']]);
        expect(widths[0]).toBe(MIN_COLUMN);
        expect(widths[1]).toBe(MAX_COLUMN);
    });

    it('stretches a narrow table to the message width, and leaves a wide one to scroll', () => {
        expect(fillWidths([100, 100], 300)).toEqual([150, 150]);
        expect(fillWidths([100, 101], 300).reduce((a, b) => a + b)).toBe(300);
        expect(fillWidths([400, 400], 300)).toEqual([400, 400]);
        expect(fillWidths([100], 0)).toEqual([100]);
    });
});

describe('the zoom viewer', () => {
    it('keeps the scale between 1× and 5×', () => {
        expect(clampScale(0.5)).toBe(1);
        expect(clampScale(3)).toBe(3);
        expect(clampScale(9)).toBe(5);
    });

    it('keeps a zoomed picture on the screen', () => {
        expect(clampOffset(500, 400, 2)).toBe(200);
        expect(clampOffset(-500, 400, 2)).toBe(-200);
        expect(clampOffset(50, 400, 1)).toBe(0);
    });
});

describe('chart geometry', () => {
    const chart = buildChart(
        readChartSource(
            JSON.stringify({
                data: { values: [{ c: 'A', s: 'x', v: 2 }, { c: 'A', s: 'y', v: 3 }, { c: 'B', s: 'x', v: 4 }] },
                mark: 'bar',
                encoding: { x: { field: 'c' }, y: { field: 'v' }, color: { field: 's' } },
            }),
        )!,
        ['#1', '#2'],
    ) as CartesianChart;

    it('spaces bands with Vega’s padding', () => {
        // Two bands in 210px: a step of 210 / (2 − 0.1 + 2 × 0.05) = 105.
        const band = bandScale(2, [0, 210]);
        expect(band.at(0)).toBeCloseTo(5.25, 5);
        expect(band.at(1) - band.at(0)).toBeCloseTo(105, 5);
        expect(band.band).toBeCloseTo(94.5, 5);
    });

    it('stacks bar segments on one another within a band', () => {
        const scales = buildScales(chart, 300, 200, chart.measure.ticks.map(String));
        const rects = barRects(chart, 0, scales);
        const [ax, ay] = rects.filter((r) => r.x === rects[0]!.x);
        expect(ax && ay).toBeTruthy();
        expect(Math.round(ax!.y)).toBe(Math.round(ay!.y + ay!.height));
    });

    it('draws paths and pie slices', () => {
        expect(linePath([[0, 0], [10, 5]])).toBe('M0.0,0.0 L10.0,5.0');
        expect(areaPath([[0, 1]], [[0, 9]])).toBe('M0.0,1.0 L0.0,9.0 Z');
        expect(sliceAngles([1, 1]).map((a) => a.end)).toEqual([Math.PI, Math.PI * 2]);
        expect(arcPath({ cx: 50, cy: 50 }, { inner: 0, outer: 10 }, 0, Math.PI)).toBe('M50.00,40.00 A10,10 0 0 1 50.00,60.00 L50,50 Z');
        expect(arcPath({ cx: 50, cy: 50 }, { inner: 5, outer: 10 }, 0, Math.PI)).toContain('A5,5 0 0 0');
    });
});

describe('flowcharts', () => {
    it('wraps labels near 24 characters and sizes shapes around them', () => {
        expect(wrapLabel('a label that is long enough to need wrapping')).toEqual(['a label that is long', 'enough to need wrapping']);
        expect(wrapLabel('one\ntwo')).toEqual(['one', 'two']);
        const box = nodeSize('rect', ['abc']);
        const circle = nodeSize('circle', ['abc']);
        expect(circle.width).toBe(circle.height);
        expect(nodeSize('rhombus', ['abc']).width).toBeGreaterThan(box.width);
    });

    it('lays a chart out top to bottom or left to right, with subgraphs around their nodes', () => {
        const td = layoutFlowchart(readFlowchart('graph TD\nA --> B')!);
        const [a, b] = td.nodes;
        expect(b!.y).toBeGreaterThan(a!.y);
        const lr = layoutFlowchart(readFlowchart('graph LR\nA -->|go| B')!);
        expect(lr.nodes[1]!.x).toBeGreaterThan(lr.nodes[0]!.x);
        expect(lr.edges[0]?.labelAt).not.toBeNull();
        const grouped = layoutFlowchart(readFlowchart('graph TD\nsubgraph G [Group]\nA --> B\nend')!);
        const g = grouped.groups[0]!;
        for (const n of grouped.nodes) expect(Math.abs(n.y - g.y)).toBeLessThan(g.height / 2);
        expect(td.width).toBeGreaterThan(0);
    });

    it('drops a link to something that is not a node', () => {
        const layout = layoutFlowchart({ direction: 'TB', nodes: [{ id: 'A', label: 'A', shape: 'rect' }], edges: [{ from: 'A', to: 'Z', label: '', line: 'solid', start: 'none', end: 'arrow' }], groups: [] });
        expect(layout.edges).toEqual([]);
    });

    it('curves links as d3’s curveBasis does', () => {
        expect(basisPath([{ x: 0, y: 0 }, { x: 6, y: 0 }])).toBe('M0.0,0.0 L6.0,0.0');
        expect(basisPath([{ x: 0, y: 0 }, { x: 6, y: 6 }, { x: 12, y: 0 }])).toBe(
            'M0.0,0.0 L1.0,1.0 C2.0,2.0 4.0,4.0 6.0,4.0 C8.0,4.0 10.0,2.0 11.0,1.0 L12.0,0.0',
        );
    });

    it('points arrowheads along the last segment, and stops the line short of them', () => {
        const mark = endMark('arrow', { x: 0, y: 0 }, { x: 10, y: 0 });
        expect(mark).toEqual({ kind: 'arrow', points: '10.0,0.0 1.0,4.5 1.0,-4.5' });
        expect(endMark('none', { x: 0, y: 0 }, { x: 10, y: 0 })).toBeNull();
        expect(trimForEnd([{ x: 0, y: 0 }, { x: 10, y: 0 }], 'arrow')).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
    });
});

describe('entities', () => {
    it('decodes named and numeric references, and leaves the rest as written', () => {
        expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &mdash; &euro;5')).toBe('a & b <c> "d" \'e\' — €5');
        expect(decodeEntities('&#x1F600; &#128512;')).toBe('😀 😀');
        expect(decodeEntities('&unknown; &#xD800; &amp')).toBe('&unknown; &#xD800; &amp');
    });
});
