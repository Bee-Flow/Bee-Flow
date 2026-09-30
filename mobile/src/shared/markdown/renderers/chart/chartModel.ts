/**
 * A read spec (vegaSpec.ts) made into something to draw: which axis holds
 * the categories and which the measure, the series and their colours, the
 * stacked or grouped values, the axis domains and ticks, and the legend.
 *
 * The rules are Vega-Lite's defaults, so a spec means here what it means on
 * the web: a quantitative y (or, failing that, x) is the measure; bars and
 * areas with a colour field stack (unless `stack: null`, or an `xOffset`
 * asks for grouped bars); `normalize` stacks to 100%; a measure axis keeps
 * zero in view; a colour domain is sorted, and takes the theme's chart
 * colours in that order.
 */

import { aggregateValues, distinct, inferType, numeric, orderCategories } from './chartData';
import { cartesianLayout, type Dimension, type Plan } from './chartLayout';
import { niceDomain } from './scales';
import type { Aggregate, FieldDef, LayerSpec, Row, VegaChart } from './vegaSpec';

export interface LegendItem {
    label: string;
    color: string;
}

export interface ChartPoint {
    /** The category (band) or the position (a number or a timestamp). */
    key: string;
    at: number;
    value: number;
    /** Where a stacked segment starts. */
    base: number;
}

export interface ChartSeries {
    name: string;
    color: string;
    points: ChartPoint[];
}

export interface CartesianLayer {
    mark: 'bar' | 'line' | 'area' | 'point';
    showPoints: boolean;
    series: ChartSeries[];
}

export interface CartesianChart {
    kind: 'cartesian';
    horizontal: boolean;
    dimension: Dimension;
    measure: { domain: [number, number]; ticks: number[]; percent: boolean };
    grouped: boolean;
    layers: CartesianLayer[];
    dimensionTitle: string;
    measureTitle: string;
    legend: LegendItem[];
}

export interface ArcChart {
    kind: 'arc';
    slices: { label: string; value: number; color: string }[];
    innerRadius: number;
    legend: LegendItem[];
}

export type ChartModel = CartesianChart | ArcChart | { kind: 'table'; reason: string };

/** The measure of one row: its number, or 1 when counting. */
function measureOf(row: Row, def: FieldDef): number | null {
    if (def.aggregate === 'count') return 1;
    return def.field ? numeric(row[def.field]) : numeric(def.value);
}

function seriesOf(row: Row, color: FieldDef | undefined): string {
    return color?.field ? String(row[color.field] ?? '') : '';
}

function seriesColors(names: readonly string[], palette: readonly string[]): Map<string, string> {
    return new Map(names.map((name, i) => [name, palette[i % palette.length] ?? '#888']));
}

/** Group a layer's rows by (category, series) and aggregate each group's measure. */
function groupLayer(rows: readonly Row[], layer: LayerSpec, plan: Plan): Map<string, Map<string, number>> {
    const groups = new Map<string, Map<string, number[]>>();
    const measure = layer.encoding[plan.measureChannel] as FieldDef;
    const dimension = layer.encoding[plan.dimensionChannel];
    rows.forEach((row, i) => {
        const value = measureOf(row, measure);
        if (value === null) return;
        const key = dimension?.field ? String(row[dimension.field] ?? '') : String(i);
        const series = seriesOf(row, layer.encoding.color);
        const bySeries = groups.get(key) ?? new Map<string, number[]>();
        bySeries.set(series, [...(bySeries.get(series) ?? []), value]);
        groups.set(key, bySeries);
    });
    const op: Aggregate = measure.aggregate ?? (layer.mark === 'point' ? 'mean' : 'sum');
    return new Map([...groups].map(([key, bySeries]) => [key, new Map([...bySeries].map(([s, vs]) => [s, aggregateValues(vs, op)]))]));
}

function buildArc(chart: VegaChart, layer: LayerSpec, palette: readonly string[]): ChartModel {
    const theta = layer.encoding.theta ?? layer.encoding.y;
    if (!theta) return { kind: 'table', reason: 'arc without theta' };
    const totals = new Map<string, number>();
    chart.values.forEach((row, i) => {
        const value = measureOf(row, theta);
        if (value === null || value < 0) return;
        const label = layer.encoding.color?.field ? seriesOf(row, layer.encoding.color) : String(i + 1);
        totals.set(label, (totals.get(label) ?? 0) + value);
    });
    const labels = orderCategories([...totals.keys()], layer.encoding.color?.sort ?? 'ascending', 'nominal', totals);
    const colors = seriesColors(labels, palette);
    const slices = labels.map((label) => ({ label, value: totals.get(label) ?? 0, color: colors.get(label) as string }));
    if (!slices.some((s) => s.value > 0)) return { kind: 'table', reason: 'no values' };
    return { kind: 'arc', slices, innerRadius: layer.innerRadius, legend: slices.map(({ label, color }) => ({ label, color })) };
}

function buildLayers(chart: VegaChart, plan: Plan, palette: readonly string[]): { layers: CartesianLayer[]; legend: LegendItem[] } {
    const grouped = chart.layers.map((layer) => ({ layer, groups: groupLayer(chart.values, layer, plan) }));
    const names = distinct(grouped.flatMap(({ groups }) => [...groups.values()].flatMap((m) => [...m.keys()])));
    const colorDef = chart.layers[0]?.encoding.color;
    const ordered = orderCategories(names, colorDef?.sort ?? 'ascending', colorDef?.type ?? 'nominal', new Map());
    const colors = seriesColors(ordered, palette);
    const layers = grouped.map(({ layer, groups }) => ({
        mark: layer.mark as CartesianLayer['mark'],
        showPoints: layer.showPoints,
        series: ordered.map((name) => ({
            name,
            color: colors.get(name) as string,
            points: [...groups].flatMap(([key, bySeries]) =>
                bySeries.has(name) ? [{ key, at: plan.position(key), value: bySeries.get(name) as number, base: 0 }] : [],
            ),
        })),
    }));
    const legend = colorDef?.field ? ordered.map((name) => ({ label: name, color: colors.get(name) as string })) : [];
    return { layers, legend };
}

/** Stack a layer's series in place: each point starts where the one below it ended. */
function stack(layer: CartesianLayer, normalize: boolean): void {
    const totals = new Map<string, number>();
    const tops = new Map<string, number>();
    for (const s of layer.series) for (const p of s.points) totals.set(p.key, (totals.get(p.key) ?? 0) + p.value);
    for (const s of layer.series) {
        for (const p of s.points) {
            const scale = normalize ? totals.get(p.key) || 1 : 1;
            p.base = tops.get(p.key) ?? 0;
            p.value = p.base + p.value / scale;
            tops.set(p.key, p.value);
        }
    }
}

function measureRange(layers: readonly CartesianLayer[]): [number, number] {
    const all = layers.flatMap((l) => l.series.flatMap((s) => s.points.flatMap((p) => [p.value, p.base])));
    return all.length ? [Math.min(...all), Math.max(...all)] : [0, 1];
}

/** Why a spec cannot be drawn as a single cartesian or arc chart, or null. */
function refusal(chart: VegaChart): string | null {
    if (chart.unsupported) return chart.unsupported;
    if (!chart.layers.length || !chart.values.length) return 'empty';
    const arcs = chart.layers.filter((l) => l.mark === 'arc').length;
    return arcs && chart.layers.length > 1 ? 'layered arc' : null;
}

/** Bars side by side: an xOffset asks for it, and so does turning a bar stack off. */
function isGrouped(first: LayerSpec, stackMode: FieldDef['stack'], layers: readonly CartesianLayer[]): boolean {
    const wantsGroups = !!first.encoding.xOffset || stackMode === 'none';
    return first.mark === 'bar' && wantsGroups && (layers[0]?.series.length ?? 0) > 1;
}

/** Stack each layer that stacks: bars unless grouped, areas unless `stack: null`. */
function stackLayers(layers: readonly CartesianLayer[], grouped: boolean, stackMode: FieldDef['stack']): void {
    for (const layer of layers) {
        const stacks = (layer.mark === 'bar' && !grouped) || (layer.mark === 'area' && stackMode !== 'none');
        if (stacks && layer.series.length > 1) stack(layer, stackMode === 'normalize');
    }
}

export function buildChart(chart: VegaChart, palette: readonly string[]): ChartModel {
    const refused = refusal(chart);
    if (refused) return { kind: 'table', reason: refused };
    const first = chart.layers[0] as LayerSpec;
    if (first.mark === 'arc') return buildArc(chart, first, palette);
    const plan = cartesianLayout(chart, (field) => inferType(chart.values, field));
    if (!plan) return { kind: 'table', reason: 'no measure axis' };

    const { layers, legend } = buildLayers(chart, plan, palette);
    const stackMode = first.encoding[plan.measureChannel]?.stack ?? null;
    const grouped = isGrouped(first, stackMode, layers);
    stackLayers(layers, grouped, stackMode);
    const [lo, hi] = measureRange(layers);
    return {
        kind: 'cartesian',
        horizontal: plan.horizontal,
        dimension: plan.dimension(layers.flatMap((l) => l.series.flatMap((s) => s.points))),
        measure: { ...niceDomain(lo, hi, 5, true), percent: stackMode === 'normalize' },
        grouped,
        layers,
        dimensionTitle: plan.dimensionTitle,
        measureTitle: plan.measureTitle,
        legend,
    };
}
