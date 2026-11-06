// Formatters the Adoption report needs beyond ../format.ts: money in the
// subscription's currency (through fCur, so the rounding is the Overview's),
// whole counts with group separators, and "how long ago" in days.
import { fCur } from '../format';

type Translate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

/** `€ 12.30` style: fCur's amount with the subscription's symbol. */
export function fMoney(cost: number | null | undefined, sym = '€'): string {
    return fCur(cost ?? 0).replace(/^\$/, sym);
}

/** A whole count with the locale's group separator; null reads "—". */
export function fInt(n: number | null | undefined): string {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return new Intl.NumberFormat().format(Math.round(Number(n)));
}

/** A share of a total as a whole percentage (0 when the total is 0). */
export function sharePct(part: number, total: number): number {
    if (!total) return 0;
    return Math.round((part / total) * 100);
}

const DAY = 86_400_000;

/** "today" / "yesterday" / "5 d ago" / "never" for a last-seen timestamp. */
export function fAgo(ts: string | null | undefined, t: Translate): string {
    if (!ts) return t('adoption.ago_never', 'never');
    const then = new Date(ts).getTime();
    if (!Number.isFinite(then)) return '—';
    const days = Math.floor((Date.now() - then) / DAY);
    if (days <= 0) return t('adoption.ago_today', 'today');
    if (days === 1) return t('adoption.ago_yesterday', 'yesterday');
    return t('adoption.ago_days', '{n} d ago', { n: days });
}

/** Days since a timestamp, or null. */
export function daysSince(ts: string | null | undefined): number | null {
    if (!ts) return null;
    const then = new Date(ts).getTime();
    return Number.isFinite(then) ? Math.floor((Date.now() - then) / DAY) : null;
}

/** A short locale date ("5 Nov 2026"); empty for a missing value. */
export function fDate(ts: string | null | undefined): string {
    if (!ts) return '—';
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

