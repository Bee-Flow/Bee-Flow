import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_AXIS, CHART_GRID_STROKE, CHART_TOOLTIP_STYLE, chartSeriesVar } from './chartChrome';
import useMeasuredBox from './useMeasuredBox';

interface TokenBarChartRow {
    x: string;
    n: number;
    label?: string;
}

interface TokenBarChartProps {
    data: TokenBarChartRow[];
    height?: number;
    ariaLabel: string;
    xTickFormatter?: (x: string) => string;
    tooltipLabel?: (x: string) => string;
    seriesIndex?: number;
    testId?: string;
}

/**
 * One series of counts over an ordered axis (days, months, buckets), on
 * tokens. Takes an explicit width from its wrapper (useMeasuredBox) so it
 * draws in jsdom too.
 *
 * Accessibility: the SVG is `role="img"` with a label, and the same numbers
 * are listed for a screen reader — a bar is not a sentence.
 */
export default function TokenBarChart({ data, height = 160, ariaLabel, xTickFormatter, tooltipLabel, seriesIndex = 0, testId }: TokenBarChartProps) {
    const [wrapRef, width] = useMeasuredBox();
    const rows = Array.isArray(data) ? data : [];
    const fmtX = typeof xTickFormatter === 'function' ? xTickFormatter : (x: string) => String(x);
    const fmtLabel = typeof tooltipLabel === 'function' ? tooltipLabel : fmtX;
    return (
        <div ref={wrapRef} className="w-full" data-testid={testId}>
            <div role="img" aria-label={ariaLabel}>
                <BarChart width={width} height={height} data={rows} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
                    <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
                    <XAxis dataKey="x" tick={CHART_AXIS} tickLine={false} axisLine={{ stroke: CHART_GRID_STROKE }} tickFormatter={fmtX} minTickGap={16} />
                    <YAxis tick={CHART_AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
                    <Tooltip
                        contentStyle={CHART_TOOLTIP_STYLE}
                        cursor={{ fill: 'var(--bg-secondary)' }}
                        labelFormatter={(x: unknown) => fmtLabel(x as string)}
                        formatter={(v: unknown): [string, string] => [new Intl.NumberFormat().format(Number(v) || 0), '']}
                        separator=""
                    />
                    <Bar dataKey="n" fill={chartSeriesVar(seriesIndex)} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
                </BarChart>
            </div>
            <ul className="sr-only">
                {rows.map((r) => (
                    <li key={r.x}>{`${r.label || fmtLabel(r.x)}: ${r.n}`}</li>
                ))}
            </ul>
        </div>
    );
}
