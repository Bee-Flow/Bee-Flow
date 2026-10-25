import { parseCellRef, cellName, formatValue, type Computed } from './sheetEngine';

/**
 * bar = vertical columns, hbar = horizontal bars, stacked = stacked columns,
 * pie/doughnut read the first data column, scatter takes numeric x from
 * categoriesRange, kpi is a value tile (dataRange = one cell).
 * Mirrors server/core/documents/sheetChartFields.js.
 */
export const CHART_TYPES = ['bar', 'hbar', 'line', 'area', 'pie', 'doughnut', 'scatter', 'stacked', 'kpi'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export type ChartFormat = 'number' | 'currency' | 'percent';

/** Categorical palette: mid-tone, distinct, readable on a light and a dark background. Series i gets colour i. */
export const CHART_PALETTE = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#ff9da7'] as const;
/** The grid's cell size in px (SheetCell: w-28 h-7): what a chart's size in cells is measured in. */
export const COL_PX = 112;
export const ROW_PX = 28;

const HEX = /^#[0-9a-f]{6}$/i;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const positive = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The px size a chart is drawn at: its own, else 6 x 14 cells, clamped. The
 * same rule as the server (sheetChartFields.js sizeInPx), so the editor and
 * the Excel export agree on a chart stored without a size.
 */
export function chartSize(config: Partial<Pick<SheetChartConfig, 'width' | 'height'>>): { width: number; height: number } {
    return {
        width: clamp(Math.round(positive(config.width) ?? 6 * COL_PX), 120, 1400),
        height: clamp(Math.round(positive(config.height) ?? 14 * ROW_PX), 80, 900),
    };
}

/** The colour of series / slice `i`: the chart's own `colors` when set, else the palette. */
export function chartColor(config: Pick<SheetChartConfig, 'colors'>, i: number): string {
    const list = config.colors?.length ? config.colors : CHART_PALETTE;
    return list[i % list.length];
}

export interface SheetChartConfig {
    id: string;
    type: ChartType;
    title?: string;
    /** The range that holds the numeric values to chart. */
    dataRange: string;
    /** Optional labels for each value. */
    categoriesRange?: string;
    /** Top-left cell the chart is anchored to. */
    anchor: string;
    width: number;
    height: number;
    /** Hex colours overriding the palette, series by series. */
    colors?: string[];
    format?: ChartFormat;
    /** ISO code for format 'currency', EUR when unset. */
    currency?: string;
    /** Data labels on the marks. */
    showValues?: boolean;
    /** A single-series bar chart with a colour per bar. */
    colorByCategory?: boolean;
    /** kpi: caption, and the cell the value is compared against. */
    label?: string;
    compareRange?: string;
    /** The tab whose cells it reads and shows on; a chart without one (made before tabs) shows on every tab. */
    tab?: string;
}

/** The charts that belong on `activeTab`. */
export function chartsOnTab(charts: SheetChartConfig[], activeTab: string | undefined): SheetChartConfig[] {
    return charts.filter((c) => !c.tab || !activeTab || c.tab === activeTab);
}

export interface ChartPoint { label: string; value: number; display: string }

export interface ParsedRange { c1: number; r1: number; c2: number; r2: number }

const RANGE_RE = /^\$?([A-Z]{1,2})\$?(\d+):\$?([A-Z]{1,2})\$?(\d+)$/i;
const CELL_RE = /^\$?([A-Z]{1,2})\$?(\d+)$/i;

export function parseA1Range(range: string): ParsedRange | null {
    const r = RANGE_RE.exec(range.trim());
    if (r) {
        const a = parseCellRef(`${r[1]}${r[2]}`);
        const b = parseCellRef(`${r[3]}${r[4]}`);
        if (!a || !b) return null;
        return { c1: a.col, r1: a.row, c2: b.col, r2: b.row };
    }
    const c = CELL_RE.exec(range.trim());
    if (!c) return null;
    const p = parseCellRef(`${c[1]}${c[2]}`);
    if (!p) return null;
    return { c1: p.col, r1: p.row, c2: p.col, r2: p.row };
}

function* namesIn(r: ParsedRange) {
    for (let row = r.r1; row <= r.r2; row++) {
        for (let col = r.c1; col <= r.c2; col++) {
            yield cellName(col, row);
        }
    }
}

function rangeSize(r: ParsedRange) {
    return (r.c2 - r.c1 + 1) * (r.r2 - r.r1 + 1);
}

export function chartDataFrom(config: SheetChartConfig, computed: Computed): ChartPoint[] {
    const dataR = parseA1Range(config.dataRange);
    if (!dataR) return [];
    const catR = config.categoriesRange ? parseA1Range(config.categoriesRange) : null;
    const points: ChartPoint[] = [];
    const maxRows = dataR.r2 - dataR.r1 + 1;
    for (let i = 0; i < maxRows; i++) {
        const row = dataR.r1 + i;
        const dataName = cellName(dataR.c1, row);
        const raw = computed[dataName];
        const value = typeof raw?.value === 'number' ? raw.value : Number.NaN;
        let label = '';
        if (catR && catR.r1 + i <= catR.r2) {
            const catName = cellName(catR.c1, catR.r1 + i);
            const cat = computed[catName];
            label = cat ? String(cat.display ?? '') : String(formatValue(null));
        }
        if (!label) label = String(i + 1);
        if (Number.isNaN(value)) continue;
        points.push({ label, value, display: raw?.display ?? String(value) });
    }
    return points;
}

function typeProblem(config: Partial<SheetChartConfig>, data: ParsedRange): string | null {
    if (config.type === 'kpi' && rangeSize(data) !== 1) return 'A KPI takes one cell.';
    if (config.type === 'scatter' && !config.categoriesRange) return 'A scatter chart needs the x values as categories range.';
    if (config.compareRange && !parseA1Range(config.compareRange)) return 'Compare cell is not valid.';
    if (config.colors?.some((c) => !HEX.test(c))) return 'Colours must be hex like #4e79a7.';
    return null;
}

export function validateChart(config: Partial<Omit<SheetChartConfig, 'type'>> & { type?: string }): string | null {
    if (!config.id || !config.type || !(CHART_TYPES as readonly string[]).includes(config.type)) return 'Chart needs a valid type.';
    const data = parseA1Range(config.dataRange || '');
    if (!data) return 'Chart needs a valid data range.';
    const problem = typeProblem(config as Partial<SheetChartConfig>, data);
    if (problem) return problem;
    if (config.categoriesRange && !parseA1Range(config.categoriesRange)) return 'Categories range is not valid.';
    if (!parseA1Range(config.anchor || '')) return 'Chart needs a valid anchor cell.';
    if (!config.width || !config.height) return 'Chart needs a size.';
    return null;
}
