import { useMemo } from 'react';
import {
    Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart,
    Pie, PieChart, ReferenceArea, ReferenceLine, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
    CHART_AXIS, CHART_GRID_STROKE, CHART_TOOLTIP_STYLE,
    PLACEHOLDER_DATA, PLACEHOLDER_SERIES_KEY, PLACEHOLDER_XKEY,
    makeValueFormatter, resolveSeriesColor,
} from '../chartPalette';
import useMeasuredBox from '../../../../../shared/charts/useMeasuredBox';
import { brandPalette } from '../appDesign';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { isFill } from '../styleResolver';
import { EmptyText, ErrorText, SkeletonLines, useStickyBinding } from '../uiBits';

/** App Studio runtime — 'chart'. Spec: server/appStudio/componentSpecs.js. */

const MAX_SERIES = 12;
// Mirrors LIMITS.MAX_CHART_REFERENCES in server/appStudio/componentSpecs.js.
const MAX_REFERENCES = 8;
const MAX_SCAN_ROWS = 200; // enough to type a column without walking a full page
// A band drawn at full strength swallows the line in front of it.
const BAND_OPACITY = 0.12;
const DEFAULT_REFERENCE_COLOR = '#94a3b8';
// Mirrors styleResolver.HEIGHT_PX — a height the inspector can pick must
// resolve here too, or the canvas silently falls back to md inside a cell the
// resolver already sized to the requested value.
const HEIGHT_MAP = { sm: 120, md: 200, lg: 320, xl: 620 };

/**
 * A column plots as a series when it holds at least one finite number and no
 * value that is plainly not one. Both halves matter: typing off the FIRST row
 * alone plots text columns as a flat zero line and drops any column that
 * happens to be null there. Exported for tests.
 */
export function deriveSeries(rows, xKey, alsoExclude = []) {
    const sample = rows.filter((r) => r && typeof r === 'object').slice(0, MAX_SCAN_ROWS);
    const excluded = new Set([xKey, ...alsoExclude]);
    const keys = [];
    const seen = new Set();
    for (const row of sample) {
        for (const key of Object.keys(row)) {
            if (excluded.has(key) || seen.has(key)) continue;
            seen.add(key);
            keys.push(key);
        }
    }
    return keys
        .filter((key) => isNumericColumn(sample, key))
        .slice(0, MAX_SERIES)
        .map((key) => ({ key, label: key }));
}

// ── time axis ────────────────────────────────────────────────────────
// A time chart plots against a synthetic numeric column rather than rewriting
// xKey in place: the original value stays on the row, so an onRowClick payload
// and a tooltip both still see the date the author's data actually holds.
export const TIME_KEY = '__appChartT';

/**
 * Epoch millis for a cell, or null. Numbers are taken as epoch (seconds are
 * widened to millis — a Withings `modified` is seconds, a JS timestamp is
 * millis, and guessing wrong puts every point in 1970).
 */
export function parseTimeValue(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value < 1e11 ? value * 1000 : value;
    }
    const t = Date.parse(String(value));
    return Number.isNaN(t) ? null : t;
}

/**
 * Rows with a parsed time column, oldest first. Unparseable rows are dropped
 * (a point with no date cannot be placed on a time axis) and the caller falls
 * back to a category axis when NOTHING parses, so a mis-set xKey renders the
 * data it has instead of an empty plot. Exported for tests.
 */
export function toTimeRows(rows, xKey) {
    const out = [];
    for (const row of rows) {
        const t = parseTimeValue(row[xKey]);
        if (t === null) continue;
        out.push({ ...row, [TIME_KEY]: t });
    }
    out.sort((a, b) => a[TIME_KEY] - b[TIME_KEY]);
    return out;
}

/**
 * Tick formatter matched to how much time the axis spans: a day of readings
 * wants clock times, a year wants months. One formatter for every span would
 * either repeat the same date on every tick or hide the time of day entirely.
 * Exported for tests.
 */
export function timeTickFormatter(spanMs) {
    const opts = spanMs < 2 * 86400_000
        ? { hour: '2-digit', minute: '2-digit' }
        : spanMs < 320 * 86400_000
            ? { day: 'numeric', month: 'short' }
            : { month: 'short', year: 'numeric' };
    return (v) => {
        const t = Number(v);
        if (!Number.isFinite(t)) return '';
        return new Date(t).toLocaleDateString(undefined, opts);
    };
}

function timeLabelFormatter(v) {
    const t = Number(v);
    if (!Number.isFinite(t)) return '';
    return new Date(t).toLocaleString(undefined, {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

/**
 * Bar width for a TIME axis, where recharts has no category band to size from
 * and falls back to a width that ignores how many points there are — three
 * points in a 620px plot came out as 200px-wide bars hanging off both ends.
 *
 * Leaves ~40% of each slot as the gap, splits it across side-by-side series,
 * and clamps so a two-point chart is not two slabs and a 300-point one is not
 * invisible. Exported for tests.
 */
export function timeBarSize(plotWidth, pointCount, seriesCount = 1, stacked = false) {
    const w = Number(plotWidth) > 0 ? Number(plotWidth) : 600;
    const points = Math.max(1, Number(pointCount) || 1);
    const lanes = stacked ? 1 : Math.max(1, Number(seriesCount) || 1);
    const slot = (w * 0.6) / points;
    return Math.max(2, Math.min(48, Math.floor(slot / lanes)));
}

// ── reference lines and bands ────────────────────────────────────────

/** Keep only entries the chart can actually draw. Exported for tests. */
export function usableReferenceLines(list) {
    return (Array.isArray(list) ? list : [])
        .filter((r) => r && Number.isFinite(Number(r.value)))
        .slice(0, MAX_REFERENCES);
}

/**
 * Bands need two finite bounds and a non-zero height. `from` and `to` are
 * normalised so an author who typed the healthy range backwards ("120 to 90")
 * still gets the band they meant rather than nothing. Exported for tests.
 */
export function usableReferenceBands(list) {
    const out = [];
    for (const b of Array.isArray(list) ? list : []) {
        if (!b) continue;
        const from = Number(b.from);
        const to = Number(b.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) continue;
        out.push({ ...b, from: Math.min(from, to), to: Math.max(from, to) });
        if (out.length >= MAX_REFERENCES) break;
    }
    return out;
}

function isNumericColumn(rows, key) {
    let numeric = false;
    for (const row of rows) {
        const value = row[key];
        if (value == null || value === '') continue; // a gap, not a verdict
        if (typeof value === 'object' || typeof value === 'boolean') return false;
        if (!Number.isFinite(Number(value))) return false;
        numeric = true;
    }
    return numeric;
}


export default function AppChart({ node }) {
    const { mode, runAction, actionState, dataState, scope, appDesign } = useRuntime();
    const props = node.props || {};
    const {
        chartType = 'bar', title = null, xKey = 'label', series = [],
        stacked = false, showLegend = true, showGrid = true, valueFormat = 'number',
        xType = 'category', yMin = null, yMax = null,
        referenceLines = [], referenceBands = [], unitLabel = null,
    } = props;
    // orientation (spec): only a BAR chart can lie down; every other type
    // silently ignores it. Horizontal bars read categories off the Y axis, so
    // the time-axis machinery (numeric X) steps aside for it below.
    const horizontal = chartType === 'bar' && props.orientation === 'horizontal';

    const { value: source, isLoading, error, errorCode } = useStickyBinding(
        resolveBinding(props.source, { actionState, dataState, scope }),
    );
    const [wrapRef, width, measuredHeight] = useMeasuredBox();

    const rows = useMemo(
        () => (Array.isArray(source) ? source : []).filter((r) => r && typeof r === 'object'),
        [source],
    );

    // Edit mode never shows a blank box: fall back to a built-in sample series.
    const usingPlaceholder = rows.length === 0 && mode === 'edit' && !isLoading;
    const baseData = usingPlaceholder ? PLACEHOLDER_DATA : rows;
    const baseXKey = usingPlaceholder ? PLACEHOLDER_XKEY : xKey;

    // A time axis needs a numeric x. Rows whose xKey does not parse as a date
    // are dropped — and if NONE parse (a mis-set xKey, or a placeholder whose
    // sample labels are words) the chart falls back to the category axis rather
    // than rendering an empty plot.
    const timeRows = useMemo(
        () => (xType === 'time' && !usingPlaceholder ? toTimeRows(baseData, baseXKey) : []),
        [xType, usingPlaceholder, baseData, baseXKey],
    );
    const isTime = xType === 'time' && timeRows.length > 0 && !horizontal;
    const data = isTime ? timeRows : baseData;
    const effectiveXKey = isTime ? TIME_KEY : baseXKey;

    const activeSeries = useMemo(() => {
        if (usingPlaceholder) return [{ key: PLACEHOLDER_SERIES_KEY, label: 'Sample' }];
        const configured = (Array.isArray(series) ? series : []).filter((s) => s && s.key);
        if (configured.length) return configured.slice(0, MAX_SERIES);
        // On a time axis the ORIGINAL date column is still on every row. If it
        // holds epoch numbers (Withings' `modified` does) it types as numeric
        // and would be auto-plotted as a series — a 1.7-billion-tall bar next
        // to an 81 kg one. Exclude it explicitly.
        return deriveSeries(data, effectiveXKey, isTime ? [baseXKey] : []);
    }, [usingPlaceholder, series, data, effectiveXKey, isTime, baseXKey]);

    // Brand palette (design.chartPalette:'brand') derives from the app's
    // primary colour; anything else keeps the classic categorical set.
    const palette = useMemo(
        () => (appDesign?.chartPalette === 'brand' && appDesign.primary ? brandPalette(appDesign.primary) : null),
        [appDesign?.chartPalette, appDesign?.primary],
    );

    // Charts used to be frozen: every recharts animation was hard-disabled, so
    // data appeared with a snap. They animate in the RUN view when the design
    // allows it — the edit canvas stays still (stable screenshots and tests),
    // and 'none' / the OS reduced-motion setting always win.
    const animate = mode === 'run'
        && appDesign?.motion !== 'none'
        && !(typeof window !== 'undefined' && window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    if (error) return <ErrorText error={error} errorCode={errorCode} />;

    if (isLoading) return <SkeletonLines lines={4} />;
    if (rows.length === 0 && !usingPlaceholder) {
        return <EmptyText text="No chart data yet." />;
    }

    // recharts is driven by explicit pixels here (not ResponsiveContainer), so
    // 'fill' has to become a measured number. It used to fall through
    // `HEIGHT_MAP[h] || HEIGHT_MAP.md` and silently render 200px — a chart asked
    // to fill a dashboard tile quietly ignored the request.
    const fill = isFill(node);
    const heightToken = node.style?.height;

    /*
     * A height preset sizes the grid CELL, and the chart has to fit INSIDE it —
     * title included. It used to give the plot the full preset height and then
     * put the title ABOVE that, so an `md` chart was 200px of plot plus ~28px of
     * heading inside a 200px cell. The cell scrolls (styleResolver pairs every
     * explicit height with overflow:auto), so every titled chart on the
     * dashboard grew a scrollbar and lost its bottom axis behind it. A chart you
     * have to scroll is a chart you cannot read: it must fit.
     *
     * So a sized chart lays out exactly like a filling one — column flex, title
     * takes what it needs, plot takes the rest. Only a chart with NO height at
     * all keeps a fixed box, because there is nothing to fit into.
     */
    const fitted = fill || Boolean(heightToken && heightToken !== 'auto' && HEIGHT_MAP[heightToken]);
    // Before the first measurement, subtract the title rather than overshooting
    // and clipping the axis for a frame.
    const fallback = Math.max(40, (HEIGHT_MAP[heightToken] || HEIGHT_MAP.md) - (title ? 28 : 0));
    const height = fitted
        ? (measuredHeight > 0 ? measuredHeight : fallback)
        : (HEIGHT_MAP[heightToken] || HEIGHT_MAP.md);
    const baseFmt = makeValueFormatter(valueFormat);
    // A bare number on a health axis is unreadable — 72 what? The unit rides on
    // both the tick and the tooltip so the two never disagree.
    const unit = typeof unitLabel === 'string' && unitLabel.trim() ? unitLabel.trim() : null;
    const fmt = unit ? (v) => `${baseFmt(v)} ${unit}` : baseFmt;
    const isPie = chartType === 'pie' || chartType === 'donut';

    const grid = showGrid && !isPie
        ? <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
        : null;

    // ── cartesian axes, shared by line/area/bar ──────────────────────
    const spanMs = isTime && data.length > 1 ? data[data.length - 1][TIME_KEY] - data[0][TIME_KEY] : 0;
    // A line starts exactly at its first point; a BAR is centred on it, so with
    // an unpadded domain half of the first and last bars sit outside the plot.
    // Pad by half a slot for bars only — a padded line chart would start at an
    // arbitrary date before the first reading.
    const timePad = (chartType === 'bar' && data.length) ? (spanMs / Math.max(1, data.length - 1)) / 2 || 43200_000 : 0;
    const xAxis = isTime ? (
        <XAxis
            dataKey={TIME_KEY}
            type="number"
            scale="time"
            // 'dataMin'/'dataMax' rather than recharts' default padded domain:
            // a measurement history should start at the first reading, not at a
            // rounded tick before it.
            domain={timePad
                ? [(dataMin) => dataMin - timePad, (dataMax) => dataMax + timePad]
                : ['dataMin', 'dataMax']}
            tickFormatter={timeTickFormatter(spanMs)}
            {...CHART_AXIS}
        />
    ) : (
        <XAxis dataKey={effectiveXKey} {...CHART_AXIS} />
    );

    const hasYMin = Number.isFinite(Number(yMin));
    const hasYMax = Number.isFinite(Number(yMax));
    const yAxis = (
        <YAxis
            tickFormatter={fmt}
            domain={[hasYMin ? Number(yMin) : 'auto', hasYMax ? Number(yMax) : 'auto']}
            // recharts reserves 60px for the y-axis, which a unit suffix
            // overruns: "132 mmHg" wrapped onto two lines and collided with the
            // plot. Widen by roughly the suffix, capped so a long unit cannot
            // eat the chart it is labelling.
            width={unit ? Math.min(60 + unit.length * 8, 120) : undefined}
            {...CHART_AXIS}
        />
    );

    // An author who pinned BOTH ends of the axis meant it, so a reference that
    // falls outside is clipped. With a free axis the opposite is right: grow the
    // domain so a target line is never silently missing from the plot.
    const overflow = (hasYMin && hasYMax) ? 'hidden' : 'extendDomain';
    // On a horizontal bar chart the VALUE axis is X, so a target line or a
    // healthy band flips with it — a reference is a statement about values,
    // never about categories.
    const bands = usableReferenceBands(referenceBands).map((b, i) => (
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
    const lines = usableReferenceLines(referenceLines).map((r, i) => (
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
    const references = bands.length || lines.length ? [...bands, ...lines] : null;

    const tooltip = (
        <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            formatter={(v) => fmt(v)}
            labelFormatter={isTime ? timeLabelFormatter : undefined}
        />
    );
    const legend = showLegend ? <Legend wrapperStyle={{ fontSize: 11 }} /> : null;

    // Clicking a point runs the wired action with that row. The synthetic time
    // column is stripped: the payload is the author's row, not our plumbing.
    const clickable = mode === 'run' && !!node.onRowClick && !usingPlaceholder;
    const emitRow = (row) => {
        if (!clickable || !row || typeof row !== 'object') return;
        const { [TIME_KEY]: _t, ...clean } = row;
        runAction(node.onRowClick, { formValues: clean, item: clean });
    };
    const chartClick = clickable
        ? (state) => emitRow(state?.activePayload?.[0]?.payload)
        : undefined;

    // Bar width on a time axis (see the Bar below). Undefined on a category
    // axis, where recharts' own band sizing is right.
    const barSize = isTime ? timeBarSize(width, data.length, activeSeries.length, stacked) : undefined;

    let chart = null;
    if (isPie) {
        const valueKey = activeSeries[0]?.key;
        const outer = Math.max(40, Math.min(width, height) / 2 - 28);
        const inner = chartType === 'donut' ? Math.max(24, outer * 0.58) : 0;
        chart = (
            <PieChart width={width} height={height}>
                {tooltip}
                {legend}
                <Pie
                    data={data}
                    dataKey={valueKey}
                    nameKey={effectiveXKey}
                    cx="50%"
                    cy="50%"
                    outerRadius={outer}
                    innerRadius={inner}
                    isAnimationActive={animate}
                    onClick={clickable ? ((entry) => emitRow(entry?.payload || entry)) : undefined}
                    style={clickable ? { cursor: 'pointer' } : undefined}
                >
                    {data.map((_, i) => (
                        <Cell key={i} fill={resolveSeriesColor(activeSeries[0]?.color, i, palette)} />
                    ))}
                </Pie>
            </PieChart>
        );
    } else if (chartType === 'line') {
        chart = (
            <LineChart width={width} height={height} data={data} onClick={chartClick} style={clickable ? { cursor: 'pointer' } : undefined}>
                {xAxis}
                {yAxis}
                {grid}{references}{tooltip}{legend}
                {activeSeries.map((s, i) => (
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
    } else if (chartType === 'area') {
        chart = (
            <AreaChart width={width} height={height} data={data} onClick={chartClick} style={clickable ? { cursor: 'pointer' } : undefined}>
                {xAxis}
                {yAxis}
                {grid}{references}{tooltip}{legend}
                {activeSeries.map((s, i) => {
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
    } else if (horizontal) {
        // Lying-down bars: categories on the Y, values on the X, and the value
        // written right of each bar (LabelList) — the shape "requests per
        // kind" wants when the labels are words. Stacked bars skip the labels:
        // a per-segment number at the segment's end reads as the bar's total.
        const longest = data.reduce((m, r) => Math.max(m, String(r?.[effectiveXKey] ?? '').length), 0);
        const catAxisWidth = Math.max(60, Math.min(160, 16 + 7 * longest));
        chart = (
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
                    domain={[hasYMin ? Number(yMin) : 'auto', hasYMax ? Number(yMax) : 'auto']}
                    {...CHART_AXIS}
                />
                <YAxis type="category" dataKey={effectiveXKey} width={catAxisWidth} {...CHART_AXIS} />
                {grid}{references}{tooltip}{legend}
                {activeSeries.map((s, i) => (
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
    } else {
        chart = (
            <BarChart width={width} height={height} data={data} onClick={chartClick} style={clickable ? { cursor: 'pointer' } : undefined}>
                {xAxis}
                {yAxis}
                {grid}{references}{tooltip}{legend}
                {activeSeries.map((s, i) => (
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

    return (
        <div
            className={`w-full min-w-0${fitted ? ' flex flex-col h-full min-h-0' : ''}${fill ? ' app-fill' : ''}`}
            data-app-chart={chartType}
            data-app-chart-orientation={horizontal ? 'horizontal' : undefined}
            data-app-chart-fitted={fitted || undefined}
            data-app-chart-xtype={isTime ? 'time' : 'category'}
        >
            {title ? (
                <div className={`text-sm font-semibold mb-2${fitted ? ' shrink-0' : ''}`} style={{ color: 'var(--text-primary)' }}>{title}</div>
            ) : null}
            {/* overflow-hidden, not auto: when the plot is momentarily larger
                than the room left (the frame before the first measurement) it
                gets clipped, never a scrollbar. The measurement that follows
                shrinks the plot to fit — the chart scales down rather than
                asking to be scrolled. */}
            <div
                ref={wrapRef}
                className={`w-full overflow-hidden${fitted ? ' flex-1 min-h-0' : ''}`}
                style={fitted ? undefined : { height }}
            >
                {chart}
            </div>
        </div>
    );
}
