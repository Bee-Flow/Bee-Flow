import type { ChartFormat, ChartType, SheetChartConfig } from './sheetCharts';

type FormatSpec = Pick<SheetChartConfig, 'format' | 'currency'>;

/**
 * A chart number as text, locale-aware: compact for axes ("160K", "1.2M"),
 * full for tooltips. A percent format reads 0.262 as 26.2%.
 */
export function formatChartNumber(value: number, spec: FormatSpec, locale: string, compact = false): string {
    if (!Number.isFinite(value)) return '';
    const format: ChartFormat | undefined = spec.format;
    try {
        if (format === 'percent') {
            return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: compact ? 0 : 1 }).format(value);
        }
        if (format === 'currency') {
            return new Intl.NumberFormat(locale, {
                style: 'currency', currency: spec.currency || 'EUR',
                notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 2,
            }).format(value);
        }
        return new Intl.NumberFormat(locale, { notation: compact ? 'compact' : 'standard', maximumFractionDigits: compact ? 1 : 2 }).format(value);
    } catch {
        // an unknown currency code or locale: the plain number
        return String(value);
    }
}

/** The change of a KPI as "+12.3%" (the sign always shown). */
export function formatDelta(ratio: number, locale: string): string {
    try {
        return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(ratio);
    } catch {
        return `${(ratio * 100).toFixed(1)}%`;
    }
}

/** Where a data label (showValues) sits: beside a horizontal bar, inside a stacked segment, else above the mark. */
export function valueLabelPosition(type: ChartType): 'right' | 'center' | 'top' {
    if (type === 'hbar') return 'right';
    if (type === 'stacked') return 'center';
    return 'top';
}
