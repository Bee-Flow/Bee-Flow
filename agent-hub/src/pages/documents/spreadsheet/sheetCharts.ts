import { parseCellRef, cellName, formatValue, type Computed } from './sheetEngine';

export type ChartType = 'bar' | 'line' | 'pie';

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

export function rangeSize(r: ParsedRange) {
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

export function validateChart(config: Partial<Omit<SheetChartConfig, 'type'>> & { type?: string }): string | null {
    if (!config.id || !config.type || !['bar', 'line', 'pie'].includes(config.type)) return 'Chart needs a valid type.';
    if (!parseA1Range(config.dataRange || '')) return 'Chart needs a valid data range.';
    if (config.categoriesRange && !parseA1Range(config.categoriesRange)) return 'Categories range is not valid.';
    if (!parseA1Range(config.anchor || '')) return 'Chart needs a valid anchor cell.';
    if (!config.width || !config.height) return 'Chart needs a size.';
    return null;
}
