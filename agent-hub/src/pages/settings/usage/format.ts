// Shared formatters for the Usage & Monitoring dashboard.
//
// These previously lived (duplicated, with small drifts) inside UsageSection.jsx,
// OrgFeedbackPanel.jsx and OrgTerminationsPanel.jsx. Consolidated here so every
// tab formats numbers, durations, models and dates identically.

import { shortModelName } from '@/utils/modelNames';
import { localeFormat } from '@/hooks/useLocaleFormat';

// Compact number: 1.2M / 3.4K / 999. Null/undefined → '0'.
export const fNum = (n?: number | null): string => {
    if (n == null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString?.() ?? String(n);
};

// USD currency, two decimals.
export const fCur = (c?: number | null): string => `$${(c || 0).toFixed(2)}`;

// Symbol for an ISO currency code.
export const currencySym = (c?: string | null): string =>
    (({ EUR: '€', USD: '$', GBP: '£' } as Partial<Record<string, string>>)[String(c || 'EUR').toUpperCase()] || (c || '€'));

// "8 Nov 2026 – 15 Nov 2026" from two ISO timestamps, in the app's language
// (`locale`: useTranslation's resolvedLocale), never the browser's.
export const formatDateRange = (startIso?: string | null, endIso?: string | null, locale?: string | null): string =>
    localeFormat(locale).dayRange(startIso, endIso);

// A model id's short name: its provider path and dated snapshot stripped (utils/modelNames).
export const shortModel = (m?: string | null): string => shortModelName(m);

// Relative "just now / 5 min ago / 3 hr ago" within a day, else the day, in the app's language.
export const fmtTime = (ts?: string | number | Date | null, locale?: string | null): string =>
    localeFormat(locale).relative(ts) || '—';

// Human bytes. 0/empty → '0 B'.
export const fmtBytes = (n?: number | null): string => {
    if (!n || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

// Duration in ms → "420 ms" / "1.4 s". `invalid` is returned for missing/zero
// values — pass `{ invalid: null }` when the caller hides the badge on falsy.
export const fmtDuration = (ms: number | string | null | undefined, { invalid = '—' }: { invalid?: string | null } = {}): string | null => {
    if (ms == null || ms === '') return invalid;
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return invalid;
    if (n < 1000) return `${Math.round(n)} ms`;
    return `${(n / 1000).toFixed(1)} s`;
};
