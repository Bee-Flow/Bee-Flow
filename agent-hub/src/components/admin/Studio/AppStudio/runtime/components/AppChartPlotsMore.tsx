import {
    Area, Bar, Cell, ComposedChart, Funnel, FunnelChart, LabelList, Line, PolarAngleAxis, PolarGrid,
    PolarRadiusAxis, Radar, RadarChart, Scatter, ScatterChart, XAxis, YAxis,
} from 'recharts';
import { CHART_AXIS, resolveSeriesColor } from '../chartPalette';
import type { JSX } from 'react';
import type { PlotArgs } from './AppChartPlots';
import type { ChartRow, SeriesSpec } from './AppChart.types';

/**
 * The chart kinds added in schema 3 (package LK21b): combo, scatter, funnel and radar, on the
 * same recharts the other kinds use. None of them animates, so the first paint, a screenshot
 * and the headless render all show the finished chart.
 */

const SECOND_AXIS = 'right';
const LABEL_STYLE = { fontSize: 11, fill: 'var(--text-secondary)' };

/** A number, or null for a value that is not one. */
function num(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/** One series of a combo chart: drawn as its own type, on the left or the second axis. */
function comboSeries(s: SeriesSpec, i: number, palette: string[] | null, stacked: boolean) {
    const color = resolveSeriesColor(s.color, i, palette);
    const common = { key: s.key, dataKey: s.key, name: s.label || s.key, isAnimationActive: false, ...(s.yAxis === SECOND_AXIS ? { yAxisId: SECOND_AXIS } : null) };
    if (s.type === 'line') return <Line {...common} type="monotone" stroke={color} strokeWidth={2} dot={false} />;
    if (s.type === 'area') return <Area {...common} type="monotone" stroke={color} fill={color} fillOpacity={0.2} strokeWidth={2} stackId={stacked ? 'area' : undefined} />;
    return <Bar {...common} fill={color} radius={[3, 3, 0, 0]} stackId={stacked ? 'bar' : undefined} />;
}

function comboPlot({ width, height, data, series, palette, stacked, clickable, chartClick, fmt, parts }: PlotArgs) {
    const second = series.some((s) => s.yAxis === SECOND_AXIS);
    return (
        <ComposedChart width={width} height={height} data={data} onClick={chartClick} style={clickable ? { cursor: 'pointer' } : undefined}>
            {parts.xAxis}
            {parts.yAxis}
            {second ? <YAxis yAxisId={SECOND_AXIS} orientation="right" tickFormatter={fmt} {...CHART_AXIS} /> : null}
            {parts.grid}{parts.references}{parts.tooltip}{parts.legend}
            {series.map((s, i) => comboSeries(s, i, palette, stacked))}
        </ComposedChart>
    );
}

/** The points of one scatter series: x from xKey, y from the series key, the row kept for a click. */
export function scatterPoints(data: ChartRow[], xKey: string, key: string) {
    const out: { x: number; y: number; row: ChartRow }[] = [];
    for (const row of data) {
        const x = num(row[xKey]);
        const y = num(row[key]);
        if (x !== null && y !== null) out.push({ x, y, row });
    }
    return out;
}

function scatterPlot({ width, height, data, xKey, series, palette, clickable, emitRow, fmt, valueDomain, parts }: PlotArgs) {
    return (
        <ScatterChart width={width} height={height}>
            <XAxis type="number" dataKey="x" name={xKey} domain={['auto', 'auto']} {...CHART_AXIS} />
            <YAxis type="number" dataKey="y" tickFormatter={fmt} domain={valueDomain} {...CHART_AXIS} />
            {parts.grid}{parts.references}{parts.tooltip}{parts.legend}
            {series.map((s, i) => (
                <Scatter
                    key={s.key}
                    name={s.label || s.key}
                    data={scatterPoints(data, xKey, s.key)}
                    fill={resolveSeriesColor(s.color, i, palette)}
                    isAnimationActive={false}
                    onClick={clickable ? (point: { row?: unknown; payload?: { row?: unknown } }) => emitRow(point?.payload?.row ?? point?.row) : undefined}
                    style={clickable ? { cursor: 'pointer' } : undefined}
                />
            ))}
        </ScatterChart>
    );
}

function funnelPlot({ width, height, data, xKey, series, palette, clickable, emitRow, parts }: PlotArgs) {
    const valueKey = series[0]?.key;
    return (
        <FunnelChart width={width} height={height}>
            {parts.tooltip}
            <Funnel
                data={data}
                dataKey={valueKey}
                nameKey={xKey}
                isAnimationActive={false}
                onClick={clickable ? ((entry: { payload?: unknown }) => emitRow(entry?.payload ?? entry)) : undefined}
                style={clickable ? { cursor: 'pointer' } : undefined}
            >
                {data.map((_, i) => <Cell key={i} fill={resolveSeriesColor(series[0]?.color, i, palette)} />)}
                <LabelList position="right" dataKey={xKey} style={LABEL_STYLE} />
            </Funnel>
        </FunnelChart>
    );
}

function radarPlot({ width, height, data, xKey, series, palette, fmt, parts }: PlotArgs) {
    const outer = Math.max(40, Math.min(width, height) / 2 - 32);
    return (
        <RadarChart width={width} height={height} data={data} outerRadius={outer}>
            <PolarGrid stroke="var(--border-default)" />
            <PolarAngleAxis dataKey={xKey} tick={LABEL_STYLE} />
            <PolarRadiusAxis tickFormatter={fmt} tick={LABEL_STYLE} />
            {parts.tooltip}{parts.legend}
            {series.map((s, i) => {
                const color = resolveSeriesColor(s.color, i, palette);
                return <Radar key={s.key} dataKey={s.key} name={s.label || s.key} stroke={color} fill={color} fillOpacity={0.25} isAnimationActive={false} />;
            })}
        </RadarChart>
    );
}

const MORE_PLOTS: Readonly<Record<string, (args: PlotArgs) => JSX.Element>> = {
    combo: comboPlot,
    scatter: scatterPlot,
    funnel: funnelPlot,
    radar: radarPlot,
};

/** The plot of a schema 3 chart kind, or null for the kinds AppChartPlots draws. */
export function moreChartPlot(args: PlotArgs): JSX.Element | null {
    const plot = Object.hasOwn(MORE_PLOTS, args.chartType) ? MORE_PLOTS[args.chartType] : null;
    return plot ? plot(args) : null;
}
