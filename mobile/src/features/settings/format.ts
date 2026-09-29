/**
 * Formatters shared by the settings, usage and admin screens.
 *
 * Ported from agent-hub/src/pages/settings/usage/format.js so the phone reads
 * the same numbers the same way the web dashboard does — a cost that says
 * €18.44 in one place and 18.4402 in the other looks like two different bills.
 */

import type { Numeric } from './types';

/**
 * Coerce a Postgres aggregate to a number.
 *
 * node-postgres hands back `bigint` and `numeric` columns as strings (no type
 * parser is registered in server/db.js), so `total_calls` arrives as `"1423"`
 * and every arithmetic operation on it silently becomes string concatenation.
 * Everything read out of a usage row goes through here first.
 */
export function num(value: Numeric | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** 1.2M / 3.4K / 942 — the compact form a phone has room for. */
export function compactNumber(value: Numeric | null | undefined): string {
    const n = num(value);
    if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return Math.round(n).toLocaleString();
}

/**
 * Money. Bee Flow bills in euros and the usage tables store a raw cost with
 * four decimals; two is what a person reads. Sub-cent totals get three
 * decimals rather than rounding to "€0.00", which reads as "nothing was used"
 * when something was.
 */
export function currency(value: Numeric | null | undefined, symbol = '€'): string {
    const n = num(value);
    if (n > 0 && n < 0.01) return `${symbol}${n.toFixed(3)}`;
    return `${symbol}${n.toFixed(2)}`;
}

/** Strip the provider prefix and the dated snapshot suffix from a model id. */
export function shortModel(model: string | null | undefined): string {
    if (!model) return 'Unknown';
    return model
        .replace(/^(openai|anthropic|google|azure|mistral|scaleway|local)\//, '')
        .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

/** "12 March 2026". Used where a date is a fact, not a recency cue. */
export function absoluteDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "Mon 3" — the x-axis label on the cost chart, from a 'YYYY-MM-DD' period. */
export function shortDay(period: string): string {
    const d = new Date(`${period.slice(0, 10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return period;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Sentence-case a snake_case or kebab-case server enum for display. */
export function humanise(value: string | null | undefined): string {
    if (!value) return '—';
    const spaced = value.replace(/[_-]+/g, ' ').trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Percentage of a limit consumed, clamped to 0..1.
 *
 * A null limit means "unlimited" in every plan shape the server returns, and
 * must NOT be treated as zero — that would paint a full bar for someone with
 * no cap at all.
 */
export function fractionOfLimit(used: Numeric, limit: number | null): number | null {
    if (limit === null || limit === undefined || limit <= 0) return null;
    return Math.max(0, Math.min(1, num(used) / limit));
}
