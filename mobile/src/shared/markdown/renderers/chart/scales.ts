/**
 * Scales and ticks for the native charts: "nice" round tick steps (1, 2, 5 ×
 * 10ⁿ, as d3 picks them), a linear map from values to pixels, and short tick
 * labels for numbers and dates — in the app's language (core/i18n), so a
 * Dutch chart reads "2.500" and "mrt", not "2,500" and "Mar".
 */

import { formatDate as formatInLocale, formatNumber as numberInLocale } from '@/core/i18n';

/** A step of 1, 2, 5 or 10 × 10ⁿ that splits [min, max] into about `count` parts. */
export function niceStep(span: number, count: number): number {
    if (!(span > 0) || count < 1) return 1;
    const raw = span / count;
    const power = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / power;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return nice * power;
}

/** The domain widened to whole steps, and the ticks in it. Zero is kept in view for a measure axis. */
export function niceDomain(min: number, max: number, count = 5, includeZero = true): { domain: [number, number]; ticks: number[] } {
    let lo = includeZero ? Math.min(0, min) : min;
    let hi = includeZero ? Math.max(0, max) : max;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 1], ticks: [0, 1] };
    if (lo === hi) {
        hi = lo === 0 ? 1 : hi + Math.abs(hi) * 0.5;
        lo = lo === 0 ? 0 : lo - Math.abs(lo) * 0.5;
    }
    const step = niceStep(hi - lo, count);
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v / step) * step);
    return { domain: [start, end], ticks };
}

/** value → pixel, for a domain and a pixel range (which may run backwards, as a y axis does). */
export function linear(domain: readonly [number, number], range: readonly [number, number]): (value: number) => number {
    const [d0, d1] = domain;
    const [r0, r1] = range;
    const span = d1 - d0 || 1;
    return (value) => r0 + ((value - d0) / span) * (r1 - r0);
}

/** A number as an axis label: grouped under ten thousand, then k / M / B, with the app's separators. */
export function formatNumber(value: number): string {
    const abs = Math.abs(value);
    const short = (n: number, unit: string) => `${numberInLocale(n, { maximumFractionDigits: 1 })}${unit}`;
    if (abs >= 1e9) return short(value / 1e9, 'B');
    if (abs >= 1e6) return short(value / 1e6, 'M');
    if (abs >= 1e4) return short(value / 1e3, 'k');
    return numberInLocale(value, { maximumFractionDigits: 2 });
}

/** A percentage axis (a normalised stack). */
export function formatPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

/**
 * A date as an axis label, as coarse as the axis's span asks: year, month, or
 * day — month names in the app's language. The data's timestamps are UTC, so
 * the label is built from the UTC calendar date (a local midnight carrying the
 * same year, month and day) rather than asking Intl for a time zone.
 */
export function formatDate(ms: number, spanMs: number): string {
    const d = new Date(ms);
    const day = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const DAY = 86_400_000;
    if (spanMs > 3 * 365 * DAY) return String(d.getUTCFullYear());
    if (spanMs > 60 * DAY) return formatInLocale(day, { month: 'short', year: '2-digit' });
    return formatInLocale(day, { month: 'short', day: 'numeric' });
}

/** A value from the data as a timestamp: a number as given, a date string parsed, else null. */
export function toTime(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const year = /^\d{4}$/.exec(value.trim());
    const ms = year ? Date.UTC(Number(value), 0, 1) : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}
