/**
 * Which axis of a cartesian chart is the measure and which the dimension,
 * and what kind of scale the dimension gets.
 *
 * The measure is the quantitative y, or else the quantitative x (a
 * horizontal bar chart). The dimension is a band of categories for nominal
 * and ordinal fields and for every bar chart (bars need a slot each, dates
 * included); a line, area or point chart over numbers or dates gets a
 * continuous axis instead.
 */

import { orderCategories } from './chartData';
import type { ChartPoint } from './chartModel';
import { formatDate, niceDomain, toTime } from './scales';
import type { Aggregate, FieldDef, FieldType, VegaChart } from './vegaSpec';

export type Dimension =
    | { scale: 'band'; categories: string[]; labels: string[] }
    | { scale: 'linear' | 'time'; domain: [number, number]; ticks: number[] };

export interface Plan {
    horizontal: boolean;
    measureChannel: 'x' | 'y';
    dimensionChannel: 'x' | 'y';
    /** A category key's position on a continuous axis (0 on a band, which orders by category). */
    position: (key: string) => number;
    /** The dimension axis, from the drawn points. */
    dimension: (points: readonly ChartPoint[]) => Dimension;
    dimensionTitle: string;
    measureTitle: string;
}

/** Vega-Lite's default axis titles for an aggregated measure ("Sum of sales"). */
const AGG_TITLE: Record<Aggregate, string> = { sum: 'Sum', mean: 'Average', count: 'Count', min: 'Min', max: 'Max', median: 'Median' };

export function measureTitle(def: FieldDef): string {
    if (def.title) return def.title;
    if (def.aggregate === 'count') return 'Count of Records';
    return def.aggregate && def.field ? `${AGG_TITLE[def.aggregate]} of ${def.field}` : (def.field ?? '');
}

function typeOf(def: FieldDef | undefined, infer: (field: string | null) => FieldType): FieldType {
    if (!def) return 'nominal';
    if (def.aggregate) return 'quantitative';
    return def.type ?? infer(def.field);
}

function timeTicks(lo: number, hi: number): number[] {
    if (hi <= lo) return [lo];
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n);
}

function bandDimension(def: FieldDef | undefined, type: FieldType): Plan['dimension'] {
    return (points) => {
        const totals = new Map<string, number>();
        for (const p of points) totals.set(p.key, Math.max(totals.get(p.key) ?? 0, p.value));
        const categories = orderCategories([...totals.keys()], def?.sort ?? 'ascending', type, totals);
        const times = categories.map((c) => (type === 'temporal' ? toTime(c) : null));
        const span = Math.max(0, ...times.map((t) => t ?? 0)) - Math.min(...times.map((t) => t ?? 0));
        const labels = categories.map((c, i) => (times[i] != null ? formatDate(times[i] as number, span) : c));
        return { scale: 'band', categories, labels };
    };
}

function continuousDimension(scale: 'linear' | 'time'): Plan['dimension'] {
    return (points) => {
        const ats = points.map((p) => p.at);
        const lo = ats.length ? Math.min(...ats) : 0;
        const hi = ats.length ? Math.max(...ats) : 1;
        if (scale === 'time') return { scale, domain: [lo, hi], ticks: timeTicks(lo, hi) };
        const nice = niceDomain(lo, hi, 5, false);
        return { scale, domain: nice.domain, ticks: nice.ticks };
    };
}

/** Which channel is the measure: a quantitative y, else a quantitative x; null when neither is. */
function measureChannelOf(chart: VegaChart, infer: (field: string | null) => FieldType): 'x' | 'y' | null {
    const enc = chart.layers[0]?.encoding ?? {};
    if (enc.y && typeOf(enc.y, infer) === 'quantitative') return 'y';
    if (enc.x && typeOf(enc.x, infer) === 'quantitative') return 'x';
    return null;
}

/** A band for categories and for every bar chart; else a continuous axis, in time for dates. */
function dimensionScale(chart: VegaChart, def: FieldDef | undefined, type: FieldType): 'band' | 'linear' | 'time' {
    const isBar = chart.layers.some((l) => l.mark === 'bar');
    if (isBar || !def || type === 'nominal' || type === 'ordinal') return 'band';
    return type === 'temporal' ? 'time' : 'linear';
}

function positionOf(scale: 'band' | 'linear' | 'time'): (key: string) => number {
    if (scale === 'band') return () => 0;
    return scale === 'time' ? (key) => toTime(key) ?? 0 : (key) => Number(key) || 0;
}

export function cartesianLayout(chart: VegaChart, infer: (field: string | null) => FieldType): Plan | null {
    const measureChannel = measureChannelOf(chart, infer);
    if (!measureChannel) return null;
    const enc = chart.layers[0]?.encoding ?? {};
    const horizontal = measureChannel === 'x';
    const dimensionChannel = horizontal ? 'y' : 'x';
    const dimDef = enc[dimensionChannel];
    const dimType = typeOf(dimDef, infer);
    const scale = dimensionScale(chart, dimDef, dimType);
    return {
        horizontal,
        measureChannel,
        dimensionChannel,
        position: positionOf(scale),
        dimension: scale === 'band' ? bandDimension(dimDef, dimType) : continuousDimension(scale),
        dimensionTitle: dimDef?.title ?? dimDef?.field ?? '',
        measureTitle: measureTitle(enc[measureChannel] as FieldDef),
    };
}
