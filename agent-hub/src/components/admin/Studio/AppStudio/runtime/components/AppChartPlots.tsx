import {
    Area, AreaChart, Bar, BarChart, Cell, LabelList, Line, LineChart, Pie, PieChart,
    ReferenceArea, ReferenceLine, XAxis, YAxis, type MouseHandlerDataParam,
} from 'recharts';
import { CHART_AXIS, resolveSeriesColor } from '../chartPalette';
import type { JSX, ReactNode } from 'react';
import type { ChartRow, ReferenceBandSpec, ReferenceLineSpec, SeriesSpec } from './AppChart.types';

/**
 * The recharts trees of the App Studio chart: the reference marks and one
 * plot per chart type. Moved out of AppChart.tsx verbatim; these are plain
 * functions returning elements (not components), so recharts sees exactly
 * the children it saw before.
 */

// A band drawn at full strength swallows the line in front of it.
const BAND_OPACITY = 0.12;
const DEFAULT_REFERENCE_COLOR = '#94a3b8';

export type ChartClickHandler = (state: MouseHandlerDataParam & { activePayload?: { payload?: unknown }[] }) => void;
export type ValueDomain = [number | 'auto', number | 'auto'];

/**
 * Bands and lines, already filtered to what the chart can draw. `pinned`:
 * the author set BOTH ends of the value axis.
 */
export function chartReferences({ bands: usableBands, lines: usableLines, horizontal, pinned }: {
    bands: ReferenceBandSpec[];
    lines: ReferenceLineSpec[];
    horizontal: boolean;
    pinned: boolean;
}): JSX.Element[] | null {
    // An author who pinned BOTH ends of the axis meant it, so a reference that
    // falls outside is clipped. With a free axis the opposite is right: grow the
    // domain so a target line is never silently missing from the plot.
    const overflow = pinned ? 'hidden' : 'extendDomain';
    // On a horizontal bar chart the VALUE axis is X, so a target line or a
    // healthy band flips with it — a reference is a statement about values,
    // never about categories.
    const bands = usableBands.map((b, i) => (
        <ReferenceArea
            key={`band-${i}`}
            {...(horizontal ? { x1: b.from, x2: b.to } : { y1: b.from, y2: b.to })}
            ifOverflow={overflow}
            fill={b.color || DEFAULT_REFERENCE_COLOR}
            fillOpacity={BAND_OPACITY}
            strokeOpacity={0}
            label={b.label ? { value: b.label, position: 'insideTopLeft', fontSize: 10, fill: 'var(--text-muted)' } : undefined}
        />
    ));
    const lines = usableLines.map((r, i) => (
        <ReferenceLine
            key={`refline-${i}`}
            {...(horizontal ? { x: Number(r.value) } : { y: Number(r.value) })}
            ifOverflow={overflow}
            stroke={r.color || DEFAULT_REFERENCE_COLOR}
            strokeDasharray="4 4"
            label={r.label ? { value: r.label, position: 'right', fontSize: 10, fill: 'var(--text-muted)' } : undefined}
        />
    ));
    // Bands first so they sit BEHIND the series; recharts paints in child order.
    return bands.length || lines.length ? [...bands, ...lines] : null;
}

/** The pieces every cartesian plot shares, built once by AppChart. */
export interface PlotParts {
    xAxis: ReactNode;
    yAxis: ReactNode;
    grid: ReactNode;
    references: ReactNode;
    tooltip: ReactNode;
    legend: ReactNode;
}

export interface PlotArgs {
    chartType: string;
    horizontal: boolean;
    width: number;
    height: number;
    data: ChartRow[];
    xKey: string;
    series: SeriesSpec[];
    palette: string[] | null;
    animate: boolean;
    stacked: boolean;
    clickable: boolean;
    chartClick: ChartClickHandler | undefined;
    emitRow: (row: unknown) => void;
    fmt: (v: unknown) => string;
    valueDomain: ValueDomain;
    barSize: number | undefined;
    parts: PlotParts;
}

function piePlot({ chartType, width, height, data, xKey, series, palette, animate, clickable, emitRow, parts }: PlotArgs) {
    const valueKey = series[0]?.key;
    const outer = Math.max(40, Math.min(width, height) / 2 - 28);
    const inner = chartType === 'donut' ? Math.max(24, outer * 0.58) : 0;
    return (
        <PieChart width={width} height={height}>
            {parts.tooltip}
            {parts.legend}
            <Pie
                data={data}
                dataKey={valueKey}
                nameKey={xKey}
                cx="50%"
                cy="50%"
                outerRadius={outer}
                innerRadius={inner}
                isAnimationActive={animate}
                onClick={clickable ? ((entry) => emitRow(entry?.payload || entry)) : undefined}
                style={clickable ? { cursor: 'pointer' } : undefined}
            >
                {data.map((_, i) => (
                    <Cell key={i} fill={resolveSeriesColor(series[0]?.color, i, palette)} />
                ))}
            </Pie>
        </PieChart>
    );
}

function linePlot({ width, height, data, series, palette, animate, clickable, chartClick, parts }: PlotArgs) {
    return (
        <LineChart width={width} height={height} data={data} onClick={chartClick} style={clickable ? { cursor: 'pointer' } : undefined}>
            {parts.xAxis}
            {parts.yAxis}
            {parts.grid}{parts.references}{parts.tooltip}{parts.legend}
            {series.map((s, i) => (
                <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label || s.key}
                    stroke={resolveSeriesColor(s.color, i, palette)}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={animate}
                />
            ))}
        </LineChart>
    );
}

function areaPlot({ width, height, data, series, palette, animate, stacked, clickable, chartClick, parts }: PlotArgs) {
    return (
        <AreaChart width={width} height={height} data={data} onClick={chartClick} style={clickable ? { cursor: 'pointer' } : undefined}>
            {parts.xAxis}
            {parts.yAxis}
            {parts.grid}{parts.references}{parts.tooltip}{parts.legend}
            {series.map((s, i) => {
                const color = resolveSeriesColor(s.color, i, palette);
                return (
                    <Area
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        name={s.label || s.key}
                        stackId={stacked ? 'stack' : undefined}
                        stroke={color}
                        fill={color}
                        fillOpacity={0.2}
                        strokeWidth={2}
                        isAnimationActive={animate}
                    />
                );
            })}
        </AreaChart>
    );
}

// Lying-down bars: categories on the Y, values on the X, and the value
// written right of each bar (LabelList) — the shape "requests per
// kind" wants when the labels are words. Stacked bars skip the labels:
// a per-segment number at the segment's end reads as the bar's total.
function horizontalBarPlot({ width, height, data, xKey, series, palette, animate, stacked, clickable, chartClick, fmt, valueDomain, parts }: PlotArgs) {
    const longest = data.reduce((m, r) => Math.max(m, String(r?.[xKey] ?? '').length), 0);
    const catAxisWidth = Math.max(60, Math.min(160, 16 + 7 * longest));
    return (
        <BarChart
            width={width}
            height={height}
            data={data}
            layout="vertical"
            margin={{ right: 32 }}
            onClick={chartClick}
            style={clickable ? { cursor: 'pointer' } : undefined}
        >
            <XAxis
                type="number"
                tickFormatter={fmt}
                domain={valueDomain}
                {...CHART_AXIS}
            />
            <YAxis type="category" dataKey={xKey} width={catAxisWidth} {...CHART_AXIS} />
            {parts.grid}{parts.references}{parts.tooltip}{parts.legend}
            {series.map((s, i) => (
                <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label || s.key}
                    stackId={stacked ? 'stack' : undefined}
                    fill={resolveSeriesColor(s.color, i, palette)}
                    radius={[0, 3, 3, 0]}
                    isAnimationActive={animate}
                >
                    {stacked ? null : (
                        <LabelList
                            dataKey={s.key}
                            position="right"
                            formatter={fmt}
                            style={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                        />
                    )}
                </Bar>
            ))}
        </BarChart>
    );
}

function barPlot({ width, height, data, series, palette, animate, stacked, clickable, chartClick, barSize, parts }: PlotArgs) {
    return (
        <BarChart width={width} height={height} data={data} onClick={chartClick} style={clickable ? { cursor: 'pointer' } : undefined}>
            {parts.xAxis}
            {parts.yAxis}
            {parts.grid}{parts.references}{parts.tooltip}{parts.legend}
            {series.map((s, i) => (
                <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label || s.key}
                    stackId={stacked ? 'stack' : undefined}
                    fill={resolveSeriesColor(s.color, i, palette)}
                    radius={[3, 3, 0, 0]}
                    // A category axis gives recharts bands to size bars
                    // from; a TIME axis is numeric and has none, so three
                    // points produced 200px-wide bars that hung off both
                    // ends of the plot and buried the y-axis labels.
                    barSize={barSize}
                    isAnimationActive={animate}
                />
            ))}
        </BarChart>
    );
}

/** The plot for the chart type: pie/donut, line, area, horizontal bar or bar. */
export function chartPlot(args: PlotArgs): JSX.Element {
    if (args.chartType === 'pie' || args.chartType === 'donut') return piePlot(args);
    if (args.chartType === 'line') return linePlot(args);
    if (args.chartType === 'area') return areaPlot(args);
    if (args.horizontal) return horizontalBarPlot(args);
    return barPlot(args);
}
