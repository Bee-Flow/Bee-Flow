import { Bar, BarChart, CartesianGrid, Rectangle, Tooltip, XAxis, YAxis } from 'recharts';
import type { BarShapeProps } from 'recharts';
import { CHART_AXIS, CHART_GRID_STROKE, CHART_TOOLTIP_STYLE } from './chartChrome';
import useMeasuredBox from './useMeasuredBox';

interface StackedSeries {
    key: string;
    label: string;
    /** A CSS colour, normally a `--chart-N` slot (chartSeriesVar) or a neutral ink. */
    color: string;
}

interface StackedColumn {
    x: string;
    /** The tick and screen-reader label of the column; `x` when absent. */
    label?: string;
    values: Record<string, number>;
    /** An incomplete period (the current week): drawn faded. */
    faded?: boolean;
}

interface StackedColumnChartProps {
    data: StackedColumn[];
    series: StackedSeries[];
    ariaLabel: string;
    height?: number;
    valueFormatter?: (n: number) => string;
    /** The colour of the card behind the chart: the 2 px gap between segments is a stroke in it. */
    surface?: string;
    testId?: string;
}

const FADED_OPACITY = 0.45;
const TOP_KEY = '__top';
const FADED_KEY = '__faded';

type ChartRow = Record<string, string | number | boolean>;

/** The rows recharts reads: the values flat, plus which series is the top of each column. */
function toRows(data: StackedColumn[], series: StackedSeries[]): ChartRow[] {
    return data.map((col) => {
        const row: ChartRow = { x: col.x, [FADED_KEY]: !!col.faded };
        let top = '';
        for (const s of series) {
            const v = Number(col.values?.[s.key]) || 0;
            row[s.key] = v;
            if (v > 0) top = s.key;
        }
        row[TOP_KEY] = top;
        return row;
    });
}

/** One segment: the data end of a column rounded 4 px, square at the baseline and between segments. */
function segmentShape(key: string) {
    return function Segment(props: BarShapeProps) {
        const row = (props.payload || {}) as ChartRow;
        const isTop = row[TOP_KEY] === key;
        return (
            <Rectangle
                {...props}
                radius={isTop ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                fillOpacity={row[FADED_KEY] ? FADED_OPACITY : 1}
            />
        );
    };
}

function Legend({ series }: { series: StackedSeries[] }) {
    return (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-secondary)]" aria-hidden="true">
            {series.map(s => (
                <li key={s.key} className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                    {s.label}
                </li>
            ))}
        </ul>
    );
}

/** What a screen reader hears per column: its label, its total and each non-zero series. */
function srLine(col: StackedColumn, series: StackedSeries[], fmt: (n: number) => string): string {
    const parts = series
        .map(s => ({ s, v: Number(col.values?.[s.key]) || 0 }))
        .filter(p => p.v > 0)
        .map(p => `${p.s.label} ${fmt(p.v)}`);
    const total = series.reduce((sum, s) => sum + (Number(col.values?.[s.key]) || 0), 0);
    return `${col.label || col.x}: ${fmt(total)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

/**
 * Stacked columns over an ordered axis (weeks, months) on the token palette:
 * one y axis, columns at most 24 px wide, a 2 px gap between segments, the
 * data end rounded, a legend always, a hover tooltip, and an incomplete
 * period drawn faded. Series colours are the caller's (a fixed slot per
 * series, never cycled); text stays on the text tokens.
 *
 * Accessibility: the SVG is `role="img"` with a label, and every column is
 * listed with its numbers for a screen reader.
 */
export default function StackedColumnChart({
    data, series, ariaLabel, height = 200, valueFormatter, surface = 'var(--bg-secondary)', testId,
}: StackedColumnChartProps) {
    const [wrapRef, width] = useMeasuredBox();
    const cols = Array.isArray(data) ? data : [];
    const list = Array.isArray(series) ? series : [];
    const fmt = typeof valueFormatter === 'function' ? valueFormatter : (n: number) => new Intl.NumberFormat().format(n);
    const rows = toRows(cols, list);
    const labelOf = (x: unknown) => cols.find(c => c.x === x)?.label || String(x);
    return (
        <div ref={wrapRef} className="w-full" data-testid={testId}>
            <div role="img" aria-label={ariaLabel}>
                <BarChart width={width} height={height} data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
                    <XAxis dataKey="x" tick={CHART_AXIS} tickLine={false} axisLine={{ stroke: CHART_GRID_STROKE }} tickFormatter={labelOf} minTickGap={8} />
                    <YAxis tick={CHART_AXIS} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => fmt(v)} />
                    <Tooltip
                        contentStyle={CHART_TOOLTIP_STYLE}
                        cursor={{ fill: 'var(--bg-tertiary)' }}
                        labelFormatter={labelOf}
                        formatter={(v: unknown, name: unknown): [string, string] => [fmt(Number(v) || 0), String(name)]}
                    />
                    {list.map(s => (
                        <Bar
                            key={s.key}
                            dataKey={s.key}
                            name={s.label}
                            stackId="stack"
                            fill={s.color}
                            stroke={surface}
                            strokeWidth={2}
                            maxBarSize={24}
                            isAnimationActive={false}
                            shape={segmentShape(s.key)}
                        />
                    ))}
                </BarChart>
            </div>
            <Legend series={list} />
            <ul className="sr-only">
                {cols.map(c => <li key={c.x}>{srLine(c, list, fmt)}</li>)}
            </ul>
        </div>
    );
}
