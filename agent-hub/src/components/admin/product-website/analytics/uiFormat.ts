import React from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { useTranslation } from '../../../../hooks/useTranslation';

/** One point of a series or a ranked list: a label (x) and a count (y). */
export interface SeriesPoint {
    x?: string | null;
    y?: number | null;
}

export interface BreakdownRow {
    label: string | null;
    isBlank: boolean;
    count: number;
    _key: string;
}

export interface DonutSlice {
    label: string;
    value: number;
    color: string;
}

export type CompareState = 'none' | 'flat' | 'up' | 'down' | 'new';

export interface CompareResult {
    delta: number | null;
    display: string | null;
    state: CompareState;
}

export interface SplitSegment {
    label: string;
    value: number;
    color?: string;
}

export const ACCENT = '#14b8a6';                                  // teal

export const PALETTE = ['#3b82f6', '#14b8a6', '#10b981', '#f59e0b', '#f97316', '#06b6d4', '#f43f5e', '#0ea5e9'];

export const paletteAt = (i: number): string => PALETTE[i % PALETTE.length];

/**
 * Categorical series colours, as a fixed set rather than by rank.
 *
 * PALETTE's teal and emerald are near-indistinguishable side by side, and
 * assigning by index means bars repaint when a list is filtered. Ranked lists
 * should be single-hue (length carries magnitude); only genuinely categorical
 * series need distinct colours, and then these four.
 */
export const SERIES = Object.freeze({
    primary: '#14b8a6', secondary: '#3b82f6', warn: '#f59e0b', bad: '#f43f5e',
});

/** Max of a numeric list without spreading it — `Math.max(...arr)` blows the
 *  argument limit (and throws RangeError) somewhere around 100k entries, which
 *  a busy heatmap page reaches easily. */
export function maxOf(values: number[], initial = 1): number {
    let m = initial;
    for (const v of values) if (Number.isFinite(v) && v > m) m = v;
    return m;
}

// Umami stat fields are either { value, prev } or a bare number depending on
// version — normalise both.
export const statVal = (s: { value?: number } | number | null | undefined): number => (s && typeof s === 'object' ? (s.value ?? 0) : (typeof s === 'number' ? s : 0));

export function fmtDurationSec(sec?: number | null): string {
    const s = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

/** Umami reports replay/session durations in MILLISECONDS. Formatting them as
 *  seconds turned an 11.8-second recording into "196m 21s". */
export function fmtDurationMs(ms: number | string | null | undefined): string {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '—';
    return n < 1000 ? '<1s' : fmtDurationSec(n / 1000);
}

// Pure helpers take an optional translator (`t` from useTranslation) so they
// stay callable from tests and non-React code; without one they print English.
export const plainT: TranslateFn = (_key, fallback, params) => String(fallback).replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? ''));

export function fmtAgo(ts: number | string, now: number = Date.now(), tr: TranslateFn = plainT): string {
    const at = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(at)) return '';
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 45) return tr('cms_site.analytics.common.ago_now', 'just now');
    const m = Math.round(s / 60);
    if (m < 60) return tr('cms_site.analytics.common.ago_minutes', '{n}m ago', { n: m });
    const h = Math.round(m / 60);
    if (h < 24) return tr('cms_site.analytics.common.ago_hours', '{n}h ago', { n: h });
    return tr('cms_site.analytics.common.ago_days', '{n}d ago', { n: Math.round(h / 24) });
}

/** `{ "/faq": 5, "/": 2 }` → `[{ x, y }]` sorted desc. Umami's realtime
 *  endpoint returns maps where every other endpoint returns rows. */
export function mapToRows(map: Record<string, unknown> | null | undefined): Array<{ x: string; y: number }> {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
    return Object.entries(map)
        .map(([x, y]) => ({ x, y: Number(y) || 0 }))
        .sort((a, b) => b.y - a.y);
}

/** Umami /pageviews → rows for SvgAreaChart (`period` x-label, `value` yKey). */
export function toTimeseries(series: SeriesPoint[] | null | undefined): Array<{ period: string; value: number }> {
    const arr = Array.isArray(series) ? series : [];
    return arr.map(p => ({ period: String(p.x || '').slice(0, 16).replace('T', ' '), value: p.y || 0 }));
}

/**
 * Umami /metrics → [{ x, y }] → table rows.
 *
 * A missing value is flagged with `isBlank` rather than substituted with the
 * string "(none)": renderers then choose the right words for their dimension
 * ("Direct" for a referrer, "Unknown" for a country), and — the actual bug —
 * a dimension whose real value happens to BE "(none)" stays drillable.
 */
export function toRows(arr: SeriesPoint[] | null | undefined): BreakdownRow[] {
    return (Array.isArray(arr) ? arr : []).map((d, i) => ({
        label: d.x || null,
        isBlank: !d.x,
        count: d.y || 0,
        _key: `${i}-${d.x ?? ''}`,
    }));
}

export function toDonut(arr: SeriesPoint[] | null | undefined): DonutSlice[] {
    return (Array.isArray(arr) ? arr : [])
        .filter(d => (d.y || 0) > 0)
        .map((d, i) => ({ label: d.x || '(none)', value: d.y || 0, color: paletteAt(i) }));
}

/**
 * Percentage delta vs the previous period. Umami's `stats` returns a
 * `comparison` block that the old dashboard threw away.
 */
export function deltaPct(current: unknown, previous: unknown): number | null {
    const c = Number(current) || 0;
    const p = Number(previous) || 0;
    if (!p) return null;
    return Math.round(((c - p) / p) * 100);
}

/**
 * Period-over-period comparison, aware of what kind of number it is given.
 *
 * `deltaPct` alone is wrong twice over. On a RATE it reports the relative
 * change of a percentage — a bounce rate moving 25% → 20% renders as "↓20%"
 * when the honest statement is "5 points better". And when the previous period
 * is 0 it returns null, so going from nothing to something — usually the most
 * interesting thing on the page — renders as blank space.
 *
 * @param kind 'count' | 'rate' (0-100 points) | 'duration' (seconds) | 'ratio' (0-1)
 * @returns { delta, display, state } — state ∈ up | down | flat | new | none
 */
export function compare(current: unknown, previous: unknown, kind: 'count' | 'rate' | 'ratio' | 'duration' = 'count', tr: TranslateFn = plainT): CompareResult {
    const c = Number(current);
    const p = Number(previous);
    if (!Number.isFinite(c)) return { delta: null, display: null, state: 'none' };

    if (kind === 'rate' || kind === 'ratio') {
        if (!Number.isFinite(p)) return { delta: null, display: null, state: 'none' };
        const scale = kind === 'ratio' ? 100 : 1;
        const points = (c - p) * scale;
        if (Math.abs(points) < 0.05) return { delta: 0, display: tr('cms_site.analytics.common.no_change', 'no change'), state: 'flat' };
        return {
            delta: points,
            display: tr('cms_site.analytics.common.points', '{n} pts', { n: Math.abs(points).toFixed(1) }),
            state: points > 0 ? 'up' : 'down',
        };
    }

    if (!Number.isFinite(p) || p === 0) {
        // A previous period of zero has no meaningful percentage, but "new" is
        // still information — far better than rendering nothing at all.
        if (c === 0) return { delta: null, display: null, state: 'none' };
        return { delta: 100, display: tr('cms_site.analytics.common.new', 'new'), state: 'new' };
    }

    const pct = ((c - p) / p) * 100;
    if (Math.abs(pct) < 0.5) return { delta: 0, display: tr('cms_site.analytics.common.no_change', 'no change'), state: 'flat' };
    return {
        delta: Math.round(pct),
        display: `${Math.abs(Math.round(pct))}%`,
        state: pct > 0 ? 'up' : 'down',
    };
}

/** Traffic-light for a rate where lower is better (bounce, exit). The value is
 *  always printed alongside — colour is never the only carrier. */
export function rateColor(pct: unknown): string {
    const n = Number(pct);
    if (!Number.isFinite(n)) return 'var(--text-muted, #888)';
    if (n <= 40) return '#10b981';
    if (n <= 60) return '#f59e0b';
    return '#f43f5e';
}
