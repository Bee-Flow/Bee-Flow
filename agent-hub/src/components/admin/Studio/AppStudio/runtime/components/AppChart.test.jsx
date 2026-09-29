import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AppChart, {
    deriveSeries, parseTimeValue, toTimeRows, timeTickFormatter, timeBarSize,
    usableReferenceLines, usableReferenceBands, TIME_KEY,
} from './AppChart';
import { dataCacheKey } from '../resolveBinding';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const BAR_ROWS = [
    { label: 'Jan', open: 5, closed: 2 },
    { label: 'Feb', open: 8, closed: 6 },
    { label: 'Mar', open: 3, closed: 9 },
];

function chartNode(overrides = {}) {
    return {
        id: 'cmp_chart', type: 'chart', visible: true,
        props: {
            chartType: 'bar',
            source: { kind: 'static', value: BAR_ROWS },
            title: 'Requests',
            xKey: 'label',
            series: [{ key: 'open', label: 'Open' }, { key: 'closed', label: 'Closed' }],
            stacked: false, showLegend: true, showGrid: true, valueFormat: 'number',
            ...overrides,
        },
        style: { span: 6, height: 'md' },
    };
}

const FORBIDDEN = [/#6366f1/i, /#7c3aed/i, /#a855f7/i, /indigo/i, /violet/i, /purple/i];

describe('AppChart', () => {
    it('renders a bar chart with series from bound data (run mode)', () => {
        const { container, getByText } = withRuntime(<AppChart node={chartNode()} />);
        expect(getByText('Requests')).toBeTruthy();
        expect(container.querySelector('svg.recharts-surface')).toBeTruthy();
        expect(container.querySelectorAll('.recharts-bar').length).toBeGreaterThan(0);
    });

    it('falls back to a sample series in edit mode when unbound (never blank)', () => {
        const node = chartNode({ source: { kind: 'static', value: [] }, series: [] });
        const { container } = withRuntime(<AppChart node={node} />, { mode: 'edit' });
        expect(container.querySelector('svg.recharts-surface')).toBeTruthy();
    });

    it('shows an empty state in run mode when unbound', () => {
        const node = chartNode({ source: { kind: 'static', value: [] }, series: [] });
        const { container, getByText } = withRuntime(<AppChart node={node} />, { mode: 'run' });
        expect(getByText('No chart data yet.')).toBeTruthy();
        expect(container.querySelector('svg.recharts-surface')).toBeNull();
    });

    it('renders line / area / pie / donut variants', () => {
        for (const chartType of ['line', 'area', 'pie', 'donut']) {
            const { container } = withRuntime(<AppChart node={chartNode({ chartType })} />);
            expect(container.querySelector('svg.recharts-surface')).toBeTruthy();
        }
    });

    it('emits no purple/indigo/violet colour', () => {
        const { container } = withRuntime(<AppChart node={chartNode()} />);
        const html = container.innerHTML;
        for (const re of FORBIDDEN) expect(re.test(html)).toBe(false);
    });
});

describe('deriveSeries', () => {
    it('keeps a column that is null in the first row and drops text columns', () => {
        const rows = [
            { label: 'Jan', owner: 'Ann', open: null, closed: 2 },
            { label: 'Feb', owner: 'Bob', open: 5, closed: 6 },
        ];
        expect(deriveSeries(rows, 'label')).toEqual([
            { key: 'open', label: 'open' },
            { key: 'closed', label: 'closed' },
        ]);
    });

    it('drops all-empty, boolean and object columns', () => {
        const rows = [{ label: 'Jan', note: null, done: true, meta: { a: 1 }, n: 3 }];
        expect(deriveSeries(rows, 'label')).toEqual([{ key: 'n', label: 'n' }]);
    });

    it('accepts numeric strings (the shape a SQL connector returns)', () => {
        expect(deriveSeries([{ label: 'Jan', amount: '12.5' }], 'label')).toEqual([{ key: 'amount', label: 'amount' }]);
    });
});

describe('AppChart width measurement', () => {
    it('measures the chart box once it EXISTS, not only on mount', () => {
        const observed = [];
        class CapturingResizeObserver {
            constructor(callback) { this.callback = callback; }
            observe(el) { observed.push(el); }
            unobserve() {}
            disconnect() {}
        }
        vi.stubGlobal('ResizeObserver', CapturingResizeObserver);
        try {
            const source = { kind: 'records', tableId: 'tbl_x' };
            const node = chartNode({ source });
            const key = dataCacheKey(source);
            const ui = (dataState) => (
                <RuntimeProvider value={{ ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), dataState }}>
                    <AppChart node={node} />
                </RuntimeProvider>
            );
            const { container, rerender } = render(ui({ [key]: { status: 'loading', result: undefined, error: null } }));
            // The measured div does not exist yet — a bound chart shows a skeleton.
            expect(container.querySelector('[data-app-chart]')).toBeNull();
            expect(observed.length).toBe(0);

            rerender(ui({ [key]: { status: 'success', result: BAR_ROWS, error: null } }));
            const wrap = container.querySelector('[data-app-chart]').lastElementChild;
            // recharts >= 3.9 observes its own legend and tooltip boxes too
            // (recharts#7201); this test is about the one AppChart observes.
            expect(observed.filter((el) => !el.closest('.recharts-wrapper'))).toEqual([wrap]);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

/*
 * A CHART MUST FIT ITS CELL.
 *
 * A height preset sizes the grid cell, and styleResolver pairs every explicit
 * height with overflow:auto. The chart used to give the plot the FULL preset
 * height and then stack the title above it, so an `md` chart was ~228px of
 * content in a 200px cell: every titled chart on the dashboard grew a scrollbar
 * and hid its own x-axis behind it. A chart you have to scroll cannot be read
 * at a glance, which is the only thing a chart is for.
 */
describe('AppChart - fitting the cell it was given', () => {
    const sized = (height) => {
        const n = chartNode();
        return { ...n, style: { span: 4, ...(height ? { height } : {}) } };
    };
    const plotOf = (container) => {
        const root = container.querySelector('[data-app-chart]');
        return { root, plot: root.lastElementChild };
    };

    it('lays a sized chart out as a column so the plot takes what the title leaves', () => {
        const { container } = withRuntime(<AppChart node={sized('md')} />);
        const { root, plot } = plotOf(container);
        expect(root.getAttribute('data-app-chart-fitted')).toBe('true');
        expect(root.className).toContain('h-full');
        // The plot box flexes into the remainder instead of carrying a fixed
        // height that ignores the heading above it.
        expect(plot.className).toContain('flex-1');
        expect(plot.getAttribute('style') || '').not.toMatch(/height/);
    });

    it('clips rather than scrolls while the measurement settles', () => {
        const { container } = withRuntime(<AppChart node={sized('lg')} />);
        const { plot } = plotOf(container);
        expect(plot.className).toContain('overflow-hidden');
        expect(plot.className).not.toContain('overflow-auto');
    });

    it('keeps its own box when no height was asked for - there is nothing to fit into', () => {
        const { container } = withRuntime(<AppChart node={sized(null)} />);
        const { root, plot } = plotOf(container);
        expect(root.getAttribute('data-app-chart-fitted')).toBeNull();
        expect(plot.getAttribute('style') || '').toMatch(/height/);
    });
});

/*
 * TIME AXIS, REFERENCE RANGES AND POINT CLICKS.
 *
 * Health data is why these exist: a weight history with a three-week hole is a
 * straight line on a category axis and an honest gap on a time one, and a
 * blood-pressure chart without its healthy band shows you a number but not
 * whether that number is fine.
 */

const TIME_ROWS = [
    { measured_at: '2026-08-03T07:00:00.000Z', weight: 81.9 },
    { measured_at: '2026-08-01T07:00:00.000Z', weight: 82.4 },   // deliberately out of order
    { measured_at: '2026-08-19T07:00:00.000Z', weight: 80.1 },   // after a gap
];

function timeChartNode(overrides = {}) {
    return chartNode({
        chartType: 'line',
        source: { kind: 'static', value: TIME_ROWS },
        xKey: 'measured_at',
        xType: 'time',
        series: [{ key: 'weight', label: 'Weight' }],
        ...overrides,
    });
}

describe('parseTimeValue', () => {
    it('reads ISO strings, Date objects and epoch millis', () => {
        expect(parseTimeValue('2026-08-01T00:00:00.000Z')).toBe(Date.parse('2026-08-01T00:00:00.000Z'));
        expect(parseTimeValue(new Date(1_700_000_000_000))).toBe(1_700_000_000_000);
        expect(parseTimeValue(1_700_000_000_000)).toBe(1_700_000_000_000);
    });

    it('widens epoch SECONDS to millis - the shape Withings sends', () => {
        // Read as millis, 1_700_000_000 lands in January 1970 and every point
        // collapses onto one tick.
        expect(parseTimeValue(1_700_000_000)).toBe(1_700_000_000_000);
    });

    it('returns null for anything that is not a date', () => {
        expect(parseTimeValue(null)).toBeNull();
        expect(parseTimeValue('')).toBeNull();
        expect(parseTimeValue('not a date')).toBeNull();
        expect(parseTimeValue(new Date('nope'))).toBeNull();
    });
});

describe('toTimeRows', () => {
    it('sorts oldest-first and leaves the original column untouched', () => {
        const rows = toTimeRows(TIME_ROWS, 'measured_at');
        expect(rows.map((r) => r.weight)).toEqual([82.4, 81.9, 80.1]);
        expect(rows[0].measured_at).toBe('2026-08-01T07:00:00.000Z');
        expect(rows[0][TIME_KEY]).toBe(Date.parse('2026-08-01T07:00:00.000Z'));
    });

    it('drops rows with no usable date rather than placing them at zero', () => {
        const rows = toTimeRows([{ measured_at: null, weight: 1 }, { measured_at: '2026-08-01', weight: 2 }], 'measured_at');
        expect(rows).toHaveLength(1);
        expect(rows[0].weight).toBe(2);
    });
});

describe('timeTickFormatter', () => {
    it('picks a granularity that matches the span', () => {
        const t = Date.parse('2026-08-19T14:30:00.000Z');
        const day = timeTickFormatter(6 * 3600_000)(t);
        const month = timeTickFormatter(30 * 86400_000)(t);
        const year = timeTickFormatter(700 * 86400_000)(t);
        // A day of readings wants clock times, a month wants days, a multi-year
        // history wants months. One formatter for all three either repeats the
        // same label on every tick or hides the time of day entirely.
        expect(day).not.toBe(month);
        expect(month).not.toBe(year);
        expect(timeTickFormatter(1000)('not a number')).toBe('');
    });
});

describe('AppChart - time axis', () => {
    it('marks the axis as a time axis when the dates parse', () => {
        const { container } = withRuntime(<AppChart node={timeChartNode()} />);
        expect(container.querySelector('[data-app-chart]').getAttribute('data-app-chart-xtype')).toBe('time');
    });

    it('falls back to a category axis when NOTHING parses, instead of an empty plot', () => {
        const node = timeChartNode({ source: { kind: 'static', value: BAR_ROWS }, xKey: 'label' });
        const { container } = withRuntime(<AppChart node={node} />);
        expect(container.querySelector('[data-app-chart]').getAttribute('data-app-chart-xtype')).toBe('category');
        expect(container.querySelector('svg.recharts-surface')).toBeTruthy();
    });

    it('never auto-plots the date column as a series when it holds epoch numbers', () => {
        // `modified` (epoch seconds) types as numeric, so an un-excluded date
        // column becomes a 1.7-billion-tall series next to an 81 kg one.
        const rows = [{ modified: 1_755_580_260, weight: 81.3 }, { modified: 1_755_666_660, weight: 80.9 }];
        const node = timeChartNode({ source: { kind: 'static', value: rows }, xKey: 'modified', series: [] });
        const { container } = withRuntime(<AppChart node={node} />);
        expect(container.querySelector('[data-app-chart]').getAttribute('data-app-chart-xtype')).toBe('time');
        expect(container.innerHTML).not.toContain('modified');
    });
});

describe('timeBarSize', () => {
    it('keeps bars inside the plot when a time axis gives recharts no band', () => {
        // The bug: three points in a 620px plot rendered as ~200px bars that
        // hung off both ends and buried the y-axis labels.
        const size = timeBarSize(620, 3);
        expect(size).toBeGreaterThan(2);
        expect(size * 3).toBeLessThan(620);
        expect(size).toBeLessThanOrEqual(48);
    });

    it('narrows as points are added, and never disappears', () => {
        expect(timeBarSize(620, 30)).toBeLessThan(timeBarSize(620, 3));
        expect(timeBarSize(620, 5000)).toBeGreaterThanOrEqual(2);
    });

    it('splits the slot across side-by-side series, but not stacked ones', () => {
        expect(timeBarSize(620, 10, 2)).toBeLessThan(timeBarSize(620, 10, 1));
        // Stacked bars share one lane, so they keep the full slot.
        expect(timeBarSize(620, 10, 2, true)).toBe(timeBarSize(620, 10, 1));
    });

    it('falls back to a sane width before the plot has been measured', () => {
        expect(timeBarSize(0, 4)).toBeGreaterThan(2);
    });
});

describe('usableReferenceLines / usableReferenceBands', () => {
    it('keeps only entries the chart can draw', () => {
        expect(usableReferenceLines([{ value: 80 }, { value: 'x' }, { label: 'no value' }, null]))
            .toEqual([{ value: 80 }]);
    });

    it('normalises a band an author typed backwards', () => {
        // "120 to 90" is what someone means by a healthy systolic range read
        // top-down; refusing it would silently drop the band.
        expect(usableReferenceBands([{ from: 120, to: 90, label: 'Normal' }]))
            .toEqual([{ from: 90, to: 120, label: 'Normal' }]);
    });

    it('drops zero-height and non-numeric bands', () => {
        expect(usableReferenceBands([{ from: 5, to: 5 }, { from: 'a', to: 3 }, null])).toEqual([]);
    });

    it('caps at the spec limit so a plot cannot become pure annotation', () => {
        const many = Array.from({ length: 20 }, (_, i) => ({ from: i, to: i + 1 }));
        expect(usableReferenceBands(many)).toHaveLength(8);
        expect(usableReferenceLines(many.map((_, i) => ({ value: i })))).toHaveLength(8);
    });
});

describe('AppChart - reference ranges and units', () => {
    it('draws a reference band and a reference line', () => {
        const node = timeChartNode({
            referenceBands: [{ from: 70, to: 80, label: 'Target' }],
            referenceLines: [{ value: 75, label: 'Goal' }],
        });
        const { container } = withRuntime(<AppChart node={node} />);
        expect(container.querySelector('.recharts-reference-area')).toBeTruthy();
        expect(container.querySelector('.recharts-reference-line')).toBeTruthy();
    });

    it('suffixes the y-axis ticks with the unit label', () => {
        const node = timeChartNode({ unitLabel: 'kg' });
        const { container } = withRuntime(<AppChart node={node} />);
        const ticks = Array.from(container.querySelectorAll('.recharts-cartesian-axis-tick-value'))
            .map((t) => t.textContent);
        // The y ticks are the purely numeric ones (the x ticks are formatted
        // dates). Every one of them must carry the unit, and none may be left
        // bare — a unitless number on a weight axis is the regression here.
        expect(ticks.some((t) => /^-?[\d.,]+ kg$/.test(t))).toBe(true);
        expect(ticks.some((t) => /^-?[\d.,]+$/.test(t))).toBe(false);
    });

    it('renders no reference marks when none are configured', () => {
        const { container } = withRuntime(<AppChart node={timeChartNode()} />);
        expect(container.querySelector('.recharts-reference-area')).toBeNull();
        expect(container.querySelector('.recharts-reference-line')).toBeNull();
    });
});

describe('AppChart - onRowClick', () => {
    it('is inert without a wired action (no pointer affordance)', () => {
        const { container } = withRuntime(<AppChart node={timeChartNode()} />, { mode: 'run' });
        expect(container.innerHTML).not.toContain('cursor: pointer');
    });

    it('offers a pointer cursor in run mode once onRowClick is wired', () => {
        const node = { ...timeChartNode(), onRowClick: 'act_open' };
        const { container } = withRuntime(<AppChart node={node} />, { mode: 'run', runAction: vi.fn() });
        expect(container.innerHTML).toContain('cursor: pointer');
    });

    it('stays inert in EDIT mode - clicking a chart on the canvas selects it, never runs it', () => {
        const node = { ...timeChartNode(), onRowClick: 'act_open' };
        const runAction = vi.fn();
        const { container } = withRuntime(<AppChart node={node} />, { mode: 'edit', runAction });
        expect(container.innerHTML).not.toContain('cursor: pointer');
        expect(runAction).not.toHaveBeenCalled();
    });
});

/**
 * chart.orientation (spec: componentSpecs.js). 'vertical' is the identity —
 * the standing bars the chart has always drawn — and the prop only means
 * anything on chartType 'bar'; every other type ignores it silently. The
 * horizontal path lays recharts on its side (layout="vertical"): categories on
 * the Y axis, values on the X, value labels right of the bars.
 */
describe('AppChart - orientation', () => {
    it('default and explicit vertical stamp no orientation attribute (identity)', () => {
        for (const props of [{}, { orientation: 'vertical' }]) {
            const { container, unmount } = withRuntime(<AppChart node={chartNode(props)} />);
            expect(container.querySelector('[data-app-chart]').getAttribute('data-app-chart-orientation')).toBeNull();
            unmount();
        }
    });

    it('horizontal bar puts the categories on the Y axis and values right of the bars', () => {
        // motion 'none' keeps recharts from animating, so the label list is in
        // the DOM on the first render instead of after an animation frame.
        const { container } = withRuntime(
            <AppChart node={chartNode({ orientation: 'horizontal' })} />,
            { appDesign: { motion: 'none' } },
        );
        expect(container.querySelector('[data-app-chart]').getAttribute('data-app-chart-orientation')).toBe('horizontal');
        expect(container.querySelectorAll('.recharts-bar').length).toBeGreaterThan(0);
        // Categories live on the Y axis now: one tick per row. (Tick TEXT is
        // empty under jsdom's zero-size text measurement — the group count is
        // the reliable signal.)
        const yTicks = [...container.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick')];
        expect(yTicks.length).toBe(3);
        // Value labels rendered by the LabelList.
        const labels = [...container.querySelectorAll('.recharts-label-list text')].map((t) => t.textContent);
        expect(labels).toContain('5');
    });

    it('stacked horizontal bars stack and skip the per-segment labels', () => {
        const { container } = withRuntime(
            <AppChart node={chartNode({ orientation: 'horizontal', stacked: true })} />,
            { appDesign: { motion: 'none' } },
        );
        expect(container.querySelectorAll('.recharts-bar').length).toBeGreaterThan(0);
        expect(container.querySelector('.recharts-label-list text')).toBeNull();
    });

    it('non-bar types ignore orientation silently', () => {
        for (const chartType of ['line', 'pie']) {
            const { container, unmount } = withRuntime(
                <AppChart node={chartNode({ chartType, orientation: 'horizontal' })} />,
            );
            expect(container.querySelector('[data-app-chart]').getAttribute('data-app-chart-orientation')).toBeNull();
            expect(container.querySelector('svg.recharts-surface')).toBeTruthy();
            unmount();
        }
    });

    it('a reference line follows the VALUE axis when the chart lies down', () => {
        const node = chartNode({
            orientation: 'horizontal',
            referenceLines: [{ value: 6, label: 'Doel' }],
        });
        const { container } = withRuntime(<AppChart node={node} />);
        expect(container.querySelector('.recharts-reference-line')).toBeTruthy();
    });

    it('horizontal emits no purple/indigo/violet', () => {
        const { container } = withRuntime(<AppChart node={chartNode({ orientation: 'horizontal' })} />);
        const html = container.innerHTML;
        for (const re of FORBIDDEN) expect(re.test(html)).toBe(false);
    });
});
