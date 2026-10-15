import type { ReactElement } from 'react';
import {
    Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, Pie, PieChart,
    ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import { formatChartNumber, valueLabelPosition } from './sheetChartFormat';
import { chartRows, scatterPoints, type ChartSeriesData } from './sheetChartSeries';
import { chartColor, type SheetChartConfig } from './sheetCharts';

const TICK = { fill: 'var(--text-secondary)', fontSize: 11 };
const TOOLTIP = { background: 'var(--bg-primary)', border: '1px solid var(--border-default)', borderRadius: 8, fontSize: 12 };
const GRID = <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" strokeOpacity={0.6} vertical={false} />;

interface PlotProps { chart: SheetChartConfig; data: ChartSeriesData; locale: string }

function PiePlot({ chart, rows, full }: { chart: SheetChartConfig; rows: Record<string, string | number | null>[]; full: (v: unknown) => string }) {
    const slices = rows.map((r) => ({ name: String(r.label), value: Number(r.s0) }));
    return (
        <PieChart>
            <Tooltip contentStyle={TOOLTIP} formatter={(v) => full(v)} />
            <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 11 }} />
            <Pie
                data={slices} dataKey="value" nameKey="name" innerRadius={chart.type === 'doughnut' ? '55%' : 0} outerRadius="80%"
                paddingAngle={chart.type === 'doughnut' ? 2 : 0} stroke="var(--bg-primary)" label={chart.showValues ? (p) => full(p.value) : false}
            >
                {/* keys by position: two slices may carry the same label */}
                {slices.map((_sl, i) => <Cell key={`slice-${i}`} fill={chartColor(chart, i)} />)}
            </Pie>
        </PieChart>
    );
}

/** The recharts drawing of every non-kpi chart type. */
export default function SheetChartPlot({ chart, data, locale }: PlotProps) {
    const compact = (v: number) => formatChartNumber(v, chart, locale, true);
    const full = (v: unknown) => (typeof v === 'number' ? formatChartNumber(v, chart, locale) : String(v ?? ''));
    const rows = chartRows(data);
    const multi = data.series.length > 1;
    const legend = multi || chart.type === 'pie' || chart.type === 'doughnut'
        ? <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 11 }} /> : null;
    const tooltip = <Tooltip contentStyle={TOOLTIP} formatter={(v) => full(v)} />;
    const labels = (k: number) => (chart.showValues
        ? <LabelList dataKey={`s${k}`} position={valueLabelPosition(chart.type)} formatter={(v) => (typeof v === 'number' ? compact(v) : '')} fontSize={10} fill="var(--text-secondary)" />
        : null);
    const xAxis = <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={{ stroke: 'var(--border-default)' }} />;
    const yAxis = <YAxis tick={TICK} tickLine={false} axisLine={false} tickFormatter={compact} width={52} />;
    let inner: ReactElement;

    if (chart.type === 'pie' || chart.type === 'doughnut') {
        inner = <PiePlot chart={chart} rows={rows} full={full} />;
    } else if (chart.type === 'scatter') {
        inner = (
            <ScatterChart>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" strokeOpacity={0.6} />
                <XAxis type="number" dataKey="x" tick={TICK} tickFormatter={(v: number) => formatChartNumber(v, { }, locale, true)} />
                <YAxis type="number" dataKey="y" tick={TICK} tickFormatter={compact} width={52} />
                {tooltip}{legend}
                {scatterPoints(data).map((s, k) => <Scatter key={`s${k}`} name={s.name} data={s.points} fill={chartColor(chart, k)} />)}
            </ScatterChart>
        );
    } else if (chart.type === 'line') {
        inner = (
            <LineChart data={rows}>
                {GRID}{xAxis}{yAxis}{tooltip}{legend}
                {data.series.map((s, k) => (
                    <Line key={`s${k}`} type="monotone" name={s.name} dataKey={`s${k}`} stroke={chartColor(chart, k)} strokeWidth={2.5} dot={false}>{labels(k)}</Line>
                ))}
            </LineChart>
        );
    } else if (chart.type === 'area') {
        inner = (
            <AreaChart data={rows}>
                {GRID}{xAxis}{yAxis}{tooltip}{legend}
                {data.series.map((s, k) => (
                    <Area key={`s${k}`} type="monotone" name={s.name} dataKey={`s${k}`} stroke={chartColor(chart, k)} fill={chartColor(chart, k)} fillOpacity={0.25} strokeWidth={2}>{labels(k)}</Area>
                ))}
            </AreaChart>
        );
    } else {
        const horizontal = chart.type === 'hbar';
        const stacked = chart.type === 'stacked';
        const byPoint = !!chart.colorByCategory && !multi;
        const radius: [number, number, number, number] = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
        const bars = data.series.map((s, k) => (
            <Bar
                key={`s${k}`} name={s.name} dataKey={`s${k}`} fill={chartColor(chart, k)} radius={stacked && k < data.series.length - 1 ? 0 : radius}
                stackId={stacked ? 'stack' : undefined} maxBarSize={48}
            >
                {byPoint && rows.map((_r, i) => <Cell key={`bar-${i}`} fill={chartColor(chart, i)} />)}
                {labels(k)}
            </Bar>
        ));
        inner = horizontal ? (
            <BarChart data={rows} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-default)" strokeOpacity={0.6} horizontal={false} />
                <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={compact} />
                <YAxis type="category" dataKey="label" tick={TICK} tickLine={false} axisLine={false} width={72} />
                {tooltip}{legend}{bars}
            </BarChart>
        ) : (
            <BarChart data={rows}>{GRID}{xAxis}{yAxis}{tooltip}{legend}{bars}</BarChart>
        );
    }
    return <ResponsiveContainer width="100%" height="100%">{inner}</ResponsiveContainer>;
}
