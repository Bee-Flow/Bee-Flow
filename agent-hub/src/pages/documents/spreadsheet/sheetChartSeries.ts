import { cellName, columnName, type Computed } from './sheetEngine';
import { parseA1Range, type SheetChartConfig } from './sheetCharts';

interface ChartSeries { name: string; values: (number | null)[] }
export interface ChartSeriesData {
    categories: string[];
    /** The numeric x of a scatter chart (categoriesRange). */
    xs: (number | null)[];
    series: ChartSeries[];
}

const MAX_SERIES = 20;
const MAX_POINTS = 2000;

const numberAt = (computed: Computed, c: number, r: number): number | null => {
    const v = computed[cellName(c, r)]?.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
};

/**
 * What a chart reads: every column of `dataRange` is a series (pie and
 * doughnut: the first column only), named by the text cell directly above its
 * first value, else by its column letter. Rows are aligned with categoriesRange.
 */
export function chartSeriesFrom(config: SheetChartConfig, computed: Computed): ChartSeriesData {
    const d = parseA1Range(config.dataRange);
    if (!d) return { categories: [], xs: [], series: [] };
    const cat = config.categoriesRange ? parseA1Range(config.categoriesRange) : null;
    const rows = Math.min(d.r2 - d.r1 + 1, MAX_POINTS);
    const lastCol = config.type === 'pie' || config.type === 'doughnut' ? d.c1 : Math.min(d.c2, d.c1 + MAX_SERIES - 1);
    const series: ChartSeries[] = [];
    for (let c = d.c1; c <= lastCol; c++) {
        const head = d.r1 > 0 ? computed[cellName(c, d.r1 - 1)]?.value : null;
        const name = typeof head === 'string' && head.trim() ? head.trim() : columnName(c);
        series.push({ name, values: Array.from({ length: rows }, (_, i) => numberAt(computed, c, d.r1 + i)) });
    }
    return {
        categories: Array.from({ length: rows }, (_, i) => (cat ? computed[cellName(cat.c1, cat.r1 + i)]?.display : '') || String(i + 1)),
        xs: cat ? Array.from({ length: rows }, (_, i) => numberAt(computed, cat.c1, cat.r1 + i)) : [],
        series,
    };
}

/** Recharts rows: `{ label, s0, s1, … }`, without the rows where no series has a number. */
export function chartRows(data: ChartSeriesData): Record<string, string | number | null>[] {
    const out: Record<string, string | number | null>[] = [];
    data.categories.forEach((label, i) => {
        if (data.series.every((s) => s.values[i] === null)) return;
        const row: Record<string, string | number | null> = { label };
        data.series.forEach((s, k) => { row[`s${k}`] = s.values[i]; });
        out.push(row);
    });
    return out;
}

/** Scatter points per series: x from the categories range, rows without both numbers dropped. */
export function scatterPoints(data: ChartSeriesData): { name: string; points: { x: number; y: number }[] }[] {
    return data.series.map((s) => ({
        name: s.name,
        points: s.values.flatMap((y, i) => (y !== null && data.xs[i] != null ? [{ x: data.xs[i] as number, y }] : [])),
    }));
}

export interface KpiData { value: number | null; display: string; delta: number | null }

/** The value tile: the cell's number, and the change against compareRange (as a ratio of the compared value). */
export function kpiFrom(config: SheetChartConfig, computed: Computed): KpiData {
    const d = parseA1Range(config.dataRange);
    const value = d ? numberAt(computed, d.c1, d.r1) : null;
    const cmp = config.compareRange ? parseA1Range(config.compareRange) : null;
    const base = cmp ? numberAt(computed, cmp.c1, cmp.r1) : null;
    return {
        value,
        display: d ? computed[cellName(d.c1, d.r1)]?.display ?? '' : '',
        delta: value !== null && base !== null && base !== 0 ? (value - base) / Math.abs(base) : null,
    };
}
