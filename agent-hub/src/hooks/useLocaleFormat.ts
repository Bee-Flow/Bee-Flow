// Numbers and dates in the language on screen (useTranslation's resolvedLocale),
// not the browser's: a Dutch screen in an English-US browser printed "Nov 8, 2026"
// and "10000". English is written the British way (day before month), like the
// rest of the product's English.
import { useMemo } from 'react';
import { useTranslation } from '@/hooks/useTranslation';

type DateInput = string | number | Date | null | undefined;

/** The BCP-47 tag Intl gets for an app locale: plain English is British English. */
export function intlLocale(appLocale: string | null | undefined): string {
    const tag = (appLocale || 'en').trim() || 'en';
    return tag === 'en' ? 'en-GB' : tag;
}

function toDate(value: DateInput): Date | null {
    if (value === null || value === undefined || value === '') return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
}

export interface LocaleFormat {
    /** The Intl tag in use. */
    locale: string;
    /** 10000 → "10,000" / "10.000". */
    number: (n: number | null | undefined, options?: Intl.NumberFormatOptions) => string;
    /** "8 Nov 2026" (`year: false`: "8 Nov"); '' for anything that is not a date. */
    day: (value: DateInput, opts?: { year?: boolean }) => string;
    /** "8 Nov 2026 – 15 Nov 2026"; '' when either end is missing. */
    dayRange: (start: DateInput, end: DateInput) => string;
    /** "8 Nov 2026, 14:05". */
    dateTime: (value: DateInput) => string;
    /** "just now" / "5 min. ago" / "3 hours ago" within a day, else the day. */
    relative: (value: DateInput, now?: number) => string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The formatters for one locale (pure: the hook binds the language on screen). */
export function localeFormat(appLocale: string | null | undefined): LocaleFormat {
    const locale = intlLocale(appLocale);
    const numberFmt = new Intl.NumberFormat(locale);
    const dayFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });
    const dayNoYearFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
    const dateTimeFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const rel = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
    const day: LocaleFormat['day'] = (value, opts = {}) => {
        const d = toDate(value);
        if (!d) return '';
        return (opts.year === false ? dayNoYearFmt : dayFmt).format(d);
    };
    return {
        locale,
        number: (n, options) => {
            const v = Number(n ?? 0);
            if (!Number.isFinite(v)) return '';
            return options ? new Intl.NumberFormat(locale, options).format(v) : numberFmt.format(v);
        },
        day,
        dayRange: (start, end) => {
            const a = day(start);
            const b = day(end);
            return a && b ? `${a} – ${b}` : '';
        },
        dateTime: (value) => {
            const d = toDate(value);
            return d ? dateTimeFmt.format(d) : '';
        },
        relative: (value, now = Date.now()) => {
            const d = toDate(value);
            if (!d) return '';
            const diff = now - d.getTime();
            if (diff < MINUTE) return rel.format(0, 'second');
            if (diff < HOUR) return rel.format(-Math.floor(diff / MINUTE), 'minute');
            if (diff < DAY) return rel.format(-Math.floor(diff / HOUR), 'hour');
            return day(d, { year: new Date(now).getFullYear() !== d.getFullYear() });
        },
    };
}

/** The formatters bound to the language on screen. */
export function useLocaleFormat(): LocaleFormat {
    const { resolvedLocale } = useTranslation();
    return useMemo(() => localeFormat(resolvedLocale), [resolvedLocale]);
}
