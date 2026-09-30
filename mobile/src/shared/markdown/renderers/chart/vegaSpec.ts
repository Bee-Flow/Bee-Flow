/**
 * A ```vega-lite fence, read into the subset the phone draws natively.
 *
 * The web hands the spec to vega-embed, which is a full compiler and a DOM
 * renderer — about a megabyte of JavaScript and a browser. What models write
 * in answers is overwhelmingly one of a few shapes: bars, lines, areas and
 * points over inline `data.values`, pies and donuts (`arc`), a colour field
 * for series, and now and then a `layer` of two of those. That subset is read
 * here into plain values; chartModel.ts turns it into something to draw.
 *
 * Anything outside the subset (remote data, transforms, binning, facets,
 * concatenation, other marks) is marked `unsupported` with the reason, and
 * the block then shows the spec's data as a table rather than a wrong chart.
 */

import { lookup } from '../lookup';

export type FieldType = 'quantitative' | 'nominal' | 'ordinal' | 'temporal';
export type Aggregate = 'sum' | 'mean' | 'count' | 'min' | 'max' | 'median';
export type MarkType = 'bar' | 'line' | 'area' | 'point' | 'arc';
export type Row = Record<string, unknown>;

export interface FieldDef {
    field: string | null;
    type: FieldType | null;
    aggregate: Aggregate | null;
    title: string | null;
    /**
     * `ascending` (Vega-Lite's default for a category axis), `descending`,
     * `x`/`-x`/`y`/`-y` for "by the other axis", an explicit order, or null
     * (`sort: null`) for the data's own order.
     */
    sort: string | string[] | null;
    /** `stack: null|false` turns stacking off; `normalize` stacks to 100%. */
    stack: 'zero' | 'normalize' | 'none' | null;
    /** A constant (`value`) instead of a field. */
    value: string | number | null;
}

export interface LayerSpec {
    mark: MarkType;
    /** arc: the hole in a donut, in pixels; point: filled or not; line: its points shown. */
    innerRadius: number;
    showPoints: boolean;
    encoding: Partial<Record<'x' | 'y' | 'color' | 'theta' | 'xOffset', FieldDef>>;
}

export interface VegaChart {
    title: string;
    subtitle: string;
    values: Row[];
    layers: LayerSpec[];
    /** Why the phone cannot draw this spec, or null when it can. */
    unsupported: string | null;
}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

const FIELD_TYPES: readonly FieldType[] = ['quantitative', 'nominal', 'ordinal', 'temporal'];
const SHORT_TYPES: Readonly<Record<string, FieldType>> = { Q: 'quantitative', N: 'nominal', O: 'ordinal', T: 'temporal' };
const AGGREGATES: Readonly<Record<string, Aggregate>> = {
    sum: 'sum', mean: 'mean', average: 'mean', count: 'count', min: 'min', max: 'max', median: 'median',
};
const MARKS: Readonly<Record<string, MarkType>> = { bar: 'bar', line: 'line', area: 'area', point: 'point', circle: 'point', square: 'point', arc: 'arc' };
const CHANNELS = ['x', 'y', 'color', 'theta', 'xOffset'] as const;
const UNSUPPORTED_TOP = ['transform', 'facet', 'repeat', 'concat', 'hconcat', 'vconcat', 'spec'] as const;

/** `field: "sales:Q"` shorthand, as Vega-Lite accepts it. */
function splitShorthand(field: string): { field: string; type: FieldType | null } {
    const match = /^(.*):([QNOT])$/.exec(field);
    return match ? { field: match[1] as string, type: SHORT_TYPES[match[2] as string] ?? null } : { field, type: null };
}

function readStack(v: unknown): FieldDef['stack'] {
    if (v === null || v === false) return 'none';
    if (v === 'normalize') return 'normalize';
    return v === 'zero' || v === true ? 'zero' : null;
}

function readSort(v: unknown): string | string[] | null {
    if (v === null) return null;
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String);
    if (isRecord(v) && typeof v.order === 'string') return v.order;
    return 'ascending';
}

function readField(raw: unknown): FieldDef | null {
    if (!isRecord(raw)) return null;
    const short = str(raw.field) ? splitShorthand(raw.field as string) : { field: null, type: null };
    const declared = FIELD_TYPES.find((t) => t === raw.type) ?? short.type;
    const axisTitle = isRecord(raw.axis) ? str(raw.axis.title) : null;
    const legendTitle = isRecord(raw.legend) ? str(raw.legend.title) : null;
    const value = typeof raw.value === 'string' || typeof raw.value === 'number' ? raw.value : null;
    return {
        field: short.field,
        type: declared,
        aggregate: typeof raw.aggregate === 'string' ? (lookup(AGGREGATES, raw.aggregate) ?? null) : null,
        title: str(raw.title) ?? axisTitle ?? legendTitle,
        sort: readSort(raw.sort),
        stack: readStack(raw.stack),
        value,
    };
}

/** Why a field definition is beyond the subset (binning, an unknown aggregate, a time unit), or null. */
function fieldProblem(raw: unknown): string | null {
    if (!isRecord(raw)) return null;
    if (raw.bin) return 'bin';
    if (typeof raw.aggregate === 'string' && !lookup(AGGREGATES, raw.aggregate)) return `aggregate ${raw.aggregate}`;
    if (raw.timeUnit) return 'timeUnit';
    return null;
}

function readLayer(raw: Json, shared: Json): { layer: LayerSpec | null; problem: string | null } {
    const markRaw = raw.mark ?? shared.mark;
    const markName = typeof markRaw === 'string' ? markRaw : isRecord(markRaw) ? str(markRaw.type) : null;
    const mark = markName ? lookup(MARKS, markName) : undefined;
    if (!mark) return { layer: null, problem: `mark ${markName ?? '(none)'}` };
    const markDef = isRecord(markRaw) ? markRaw : {};
    const encRaw = { ...(isRecord(shared.encoding) ? shared.encoding : {}), ...(isRecord(raw.encoding) ? raw.encoding : {}) };
    const encoding: LayerSpec['encoding'] = {};
    for (const channel of CHANNELS) {
        const problem = fieldProblem(encRaw[channel]);
        if (problem) return { layer: null, problem };
        const def = readField(encRaw[channel]);
        if (def) encoding[channel] = def;
    }
    const innerRadius = typeof markDef.innerRadius === 'number' ? markDef.innerRadius : 0;
    const showPoints = markDef.point === true || isRecord(markDef.point);
    return { layer: { mark, innerRadius, showPoints, encoding }, problem: null };
}

function readTitle(raw: unknown): { title: string; subtitle: string } {
    if (typeof raw === 'string') return { title: raw, subtitle: '' };
    if (isRecord(raw)) {
        const text = Array.isArray(raw.text) ? raw.text.join(' ') : (str(raw.text) ?? '');
        const sub = Array.isArray(raw.subtitle) ? raw.subtitle.join(' ') : (str(raw.subtitle) ?? '');
        return { title: text, subtitle: sub };
    }
    return { title: '', subtitle: '' };
}

function readValues(spec: Json): Row[] | null {
    const data = spec.data;
    if (!isRecord(data) || !Array.isArray(data.values)) return null;
    return data.values.filter(isRecord);
}

export function readChartSource(source: string): VegaChart | null {
    let spec: unknown;
    try {
        spec = JSON.parse(source);
    } catch {
        return null;
    }
    if (!isRecord(spec)) return null;
    const { title, subtitle } = readTitle(spec.title);
    const values = readValues(spec) ?? [];
    const unsupportedTop = UNSUPPORTED_TOP.find((key) => spec[key] !== undefined);
    const rawLayers = Array.isArray(spec.layer) ? spec.layer.filter(isRecord) : [spec];
    const layers: LayerSpec[] = [];
    let problem: string | null = readValues(spec) ? null : 'data';
    for (const raw of rawLayers) {
        if (raw.data !== undefined && raw !== spec) problem = problem ?? 'layer data';
        const read = readLayer(raw, spec);
        if (read.layer) layers.push(read.layer);
        problem = problem ?? read.problem;
    }
    return { title, subtitle, values, layers, unsupported: unsupportedTop ?? problem };
}
