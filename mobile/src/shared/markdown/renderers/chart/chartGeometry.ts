/**
 * Pixels for a cartesian chart: the plot box inside the axes, the band and
 * linear scales, and the shapes each mark draws — bars (stacked or grouped),
 * line and area paths, points. Pure, so the geometry is tested without a
 * renderer; CartesianChart.tsx only paints what comes out.
 *
 * Sizes follow the web's mobile config (VegaLiteRenderer.jsx): 200px tall,
 * 9–10px axis labels, bars with a 2px end radius, lines 2px wide.
 */

import type { CartesianChart, ChartPoint } from './chartModel';
import { linear } from './scales';

export const CHART_HEIGHT = 200;
export const LABEL_SIZE = 10;
const CHAR = LABEL_SIZE * 0.58;
const TITLE_ROOM = 16;

export interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export interface Scales {
    box: Box;
    /** Where a point sits along the dimension, and how wide its band is (0 on a continuous axis). */
    place: (p: ChartPoint) => { at: number; band: number };
    /** A measure value's pixel along the measure axis. */
    measure: (value: number) => number;
    /** Category labels are drawn slanted when they would collide. */
    slanted: boolean;
}

function textWidth(text: string): number {
    return Math.min(text.length, 18) * CHAR;
}

/** Room for the axes: the measure's tick labels, the dimension's labels (slanted if crowded), the titles. */
export function plotBox(model: CartesianChart, width: number, height: number, measureLabels: string[]): Box & { slanted: boolean } {
    const dimLabels = model.dimension.scale === 'band' ? model.dimension.labels : [];
    const widestMeasure = Math.max(0, ...measureLabels.map(textWidth));
    const widestDim = Math.max(0, ...dimLabels.map(textWidth));
    const titleLeft = (model.horizontal ? model.dimensionTitle : model.measureTitle) ? TITLE_ROOM : 0;
    const titleBottom = (model.horizontal ? model.measureTitle : model.dimensionTitle) ? TITLE_ROOM : 0;
    if (model.horizontal) {
        return { left: Math.min(widestDim, width * 0.35) + 8 + titleLeft, top: 8, right: 12, bottom: LABEL_SIZE + 10 + titleBottom, slanted: false };
    }
    const left = widestMeasure + 8 + titleLeft;
    const perBand = dimLabels.length ? (width - left - 12) / dimLabels.length : Infinity;
    const slanted = widestDim + 4 > perBand;
    const labelDepth = slanted ? Math.min(widestDim * 0.72 + 6, height * 0.35) : LABEL_SIZE + 8;
    return { left, top: 10, right: 12, bottom: labelDepth + titleBottom, slanted };
}

/** Vega's band padding: between bands, and at either end. */
const BAND_INNER = 0.1;
const BAND_OUTER = 0.05;

/** A band scale: `n` slots across [start, end], with Vega's inner and outer padding. */
export function bandScale(n: number, [start, end]: readonly [number, number]): { at: (i: number) => number; band: number } {
    const inner = BAND_INNER;
    const outer = BAND_OUTER;
    const step = (end - start) / Math.max(1, n - inner + 2 * outer);
    const band = step * (1 - inner);
    return { at: (i) => start + step * outer + i * step, band };
}

export function buildScales(model: CartesianChart, width: number, height: number, measureLabels: string[]): Scales {
    const { slanted, ...box } = plotBox(model, width, height, measureLabels);
    const along: [number, number] = model.horizontal ? [box.top, height - box.bottom] : [box.left, width - box.right];
    const across: [number, number] = model.horizontal ? [box.left, width - box.right] : [height - box.bottom, box.top];
    const measure = linear(model.measure.domain, across);
    const dim = model.dimension;
    if (dim.scale === 'band') {
        const index = new Map(dim.categories.map((c, i) => [c, i]));
        const scale = bandScale(dim.categories.length, along);
        return { box, measure, slanted, place: (p) => ({ at: scale.at(index.get(p.key) ?? 0), band: scale.band }) };
    }
    const pos = linear(dim.domain, along);
    return { box, measure, slanted, place: (p) => ({ at: pos(p.at), band: 0 }) };
}

export interface BarRect {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
}

/** One layer's bars: stacked segments, or grouped side by side within each band. */
export function barRects(model: CartesianChart, layerIndex: number, scales: Scales): BarRect[] {
    const layer = model.layers[layerIndex];
    if (!layer) return [];
    const count = layer.series.length;
    return layer.series.flatMap((series, si) =>
        series.points.map((p) => {
            const { at, band } = scales.place(p);
            const slot = model.grouped ? band / count : band;
            const offset = model.grouped ? si * slot : 0;
            const a = scales.measure(p.base);
            const b = scales.measure(p.value);
            const lo = Math.min(a, b);
            const size = Math.abs(b - a);
            return model.horizontal
                ? { x: lo, y: at + offset, width: size, height: slot, color: series.color }
                : { x: at + offset, y: lo, width: slot, height: size, color: series.color };
        }),
    );
}

/** A series' points in drawing order, as pixel pairs (band centres on a band axis). */
export function seriesXY(model: CartesianChart, points: readonly ChartPoint[], scales: Scales, top = true): [number, number][] {
    const placed = points.map((p) => ({ p, ...scales.place(p) })).sort((a, b) => a.at - b.at);
    return placed.map(({ p, at, band }) => {
        const along = at + band / 2;
        const across = scales.measure(top ? p.value : p.base);
        return model.horizontal ? [across, along] : [along, across];
    });
}

export function linePath(xy: readonly [number, number][]): string {
    return xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

/** An area between a series' tops and its bases (the axis, or the series stacked below). */
export function areaPath(tops: readonly [number, number][], bases: readonly [number, number][]): string {
    if (!tops.length) return '';
    return `${linePath(tops)} ${[...bases].reverse().map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} Z`;
}

/** A pie slice (or a donut's, with an inner radius), from angle a0 to a1 in radians, clockwise from 12 o'clock. */
export function arcPath(
    { cx, cy }: { cx: number; cy: number },
    { inner, outer }: { inner: number; outer: number },
    a0: number,
    a1: number,
): string {
    const sweep = Math.min(a1 - a0, Math.PI * 2 - 1e-6);
    const end = a0 + sweep;
    const point = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
    const large = sweep > Math.PI ? 1 : 0;
    const outerArc = `M${point(outer, a0)} A${outer},${outer} 0 ${large} 1 ${point(outer, end)}`;
    if (inner <= 0) return `${outerArc} L${cx},${cy} Z`;
    return `${outerArc} L${point(inner, end)} A${inner},${inner} 0 ${large} 0 ${point(inner, a0)} Z`;
}

/** Each slice's start and end angle, clockwise from twelve o'clock, in proportion to its value. */
export function sliceAngles(values: readonly number[]): { start: number; end: number }[] {
    const total = values.reduce((sum, v) => sum + v, 0) || 1;
    const out: { start: number; end: number }[] = [];
    for (const value of values) {
        const start = out.length ? (out[out.length - 1] as { end: number }).end : 0;
        out.push({ start, end: start + (value / total) * Math.PI * 2 });
    }
    return out;
}
