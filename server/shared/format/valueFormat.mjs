// @typecheck strict
/**
 * App Studio value formatting: how a number, an amount, a percentage or a date is written for
 * people, in one place for every caller (the shared cell renderer of table and data_grid, the
 * chart's value axis and tooltip, the stat tile).
 *
 * Two inputs, both optional:
 *   app      definition.format      { language, currency, currencyDecimals, dateFormat, timeZone }
 *   options  a formatOptions object { currency, decimals, pattern, compact, percentScale }
 *            (and, from a data-model field's display block, dateStyle and unit: withFieldDisplay)
 *
 * THE LEGACY PATH. With neither present, formatContext() is null and every function below calls
 * exactly what the runtime called before this module existed (LEGACY: toLocaleString with the
 * viewer's own locale, EUR without decimals, one decimal on a percentage). An app that does not
 * use `format` or `formatOptions` therefore writes every value byte for byte as it always did;
 * valueFormat.test.mjs compares the two over a value table.
 *
 * With either present, a key that is set changes only what it names and everything else keeps
 * the legacy choice (an app that sets only `language` still writes amounts in EUR without
 * decimals). A column's own options win over the app's. Intl objects are cached; a value Intl
 * refuses (a hand-edited draft with a bad time zone) falls back to the legacy text instead of
 * breaking the cell.
 *
 * Generated to the web as agent-hub/src/shared/format/ (scripts/shared-mirror.manifest.json).
 */

import { parseDatePattern, renderDatePattern } from './datePattern.mjs';
import { DATE_STYLES, isCurrencyCode, isDecimals } from './formatClean.mjs';

/** @typedef {import('./datePattern.mjs').PatternPart} PatternPart */
/** @typedef {import('./datePattern.mjs').DateFields} DateFields */
/** @typedef {{ language?: string, currency?: string, currencyDecimals?: number, dateFormat?: string, timeZone?: string }} AppFormat */
/** @typedef {{ currency?: string, decimals?: number, pattern?: string, compact?: boolean, percentScale?: string, dateStyle?: string, unit?: string }} FormatOptions */
/** @typedef {{ app: AppFormat, options: FormatOptions }} FormatContext */
/** @typedef {'number' | 'currency' | 'percent'} NumberKind */
/** @typedef {'date' | 'datetime'} DateKind */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} v */
const hasAnyKey = (v) => isObject(v) && Object.values(v).some((x) => x !== undefined && x !== null);

/** What the runtime called before this module, verbatim. */
export const LEGACY = Object.freeze({
    number: (/** @type {number} */ n) => n.toLocaleString(),
    percent: (/** @type {number} */ n) => `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
    currency: (/** @type {number} */ n) => n.toLocaleString(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }),
    date: (/** @type {Date} */ d) => d.toLocaleDateString(),
    datetime: (/** @type {Date} */ d) => d.toLocaleString(),
});

/**
 * The context the formatters run in, or null for the legacy path (neither shape has a key).
 * @param {unknown} app
 * @param {unknown} [options]
 * @returns {FormatContext | null}
 */
export function formatContext(app, options) {
    const a = hasAnyKey(app) ? /** @type {AppFormat} */ (app) : null;
    const o = hasAnyKey(options) ? /** @type {FormatOptions} */ (options) : null;
    if (!a && !o) return null;
    return { app: a || {}, options: o || {} };
}

// ── Intl caches ─────────────────────────────────────────────────────

const MAX_CACHED = 200;
/** @type {Map<string, Intl.NumberFormat>} */
const numberFormats = new Map();
/** @type {Map<string, Intl.DateTimeFormat>} */
const dateFormats = new Map();

/**
 * @param {string | undefined} locale
 * @param {Intl.NumberFormatOptions} opts
 */
function numberFormat(locale, opts) {
    const key = `${locale || ''}|${JSON.stringify(opts)}`;
    let f = numberFormats.get(key);
    if (!f) {
        if (numberFormats.size >= MAX_CACHED) numberFormats.clear();
        f = new Intl.NumberFormat(locale, opts);
        numberFormats.set(key, f);
    }
    return f;
}

/**
 * @param {string | undefined} locale
 * @param {Intl.DateTimeFormatOptions} opts
 */
function dateFormat(locale, opts) {
    const key = `${locale || ''}|${JSON.stringify(opts)}`;
    let f = dateFormats.get(key);
    if (!f) {
        if (dateFormats.size >= MAX_CACHED) dateFormats.clear();
        f = new Intl.DateTimeFormat(locale, opts);
        dateFormats.set(key, f);
    }
    return f;
}

// ── Numbers ─────────────────────────────────────────────────────────

/**
 * @param {unknown} decimals
 * @param {Intl.NumberFormatOptions} fallback
 * @returns {Intl.NumberFormatOptions}
 */
const digits = (decimals, fallback) => (isDecimals(decimals)
    ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
    : fallback);

/**
 * The Intl options of one kind, and the text written after the number.
 * @param {NumberKind} kind
 * @param {FormatContext} ctx
 * @returns {{ opts: Intl.NumberFormatOptions, suffix: string }}
 */
function numberOptions(kind, { app, options }) {
    /** @type {Intl.NumberFormatOptions} */
    const compact = options.compact === true ? { notation: 'compact' } : {};
    if (kind === 'currency') {
        const currency = isCurrencyCode(options.currency) ? options.currency : (isCurrencyCode(app.currency) ? app.currency : 'EUR');
        const decimals = isDecimals(options.decimals) ? options.decimals : app.currencyDecimals;
        return { opts: { style: 'currency', currency, ...digits(decimals, { maximumFractionDigits: 0 }), ...compact }, suffix: '' };
    }
    if (kind === 'percent') {
        if (options.percentScale === 'fraction') return { opts: { style: 'percent', ...digits(options.decimals, { maximumFractionDigits: 1 }) }, suffix: '' };
        return { opts: digits(options.decimals, { maximumFractionDigits: 1 }), suffix: '%' };
    }
    return { opts: { ...digits(options.decimals, {}), ...compact }, suffix: '' };
}

/** @param {unknown} kind @returns {NumberKind} */
const numberKind = (kind) => (kind === 'currency' || kind === 'percent' ? kind : 'number');

/**
 * A finite number written as `kind` ('number' | 'currency' | 'percent'; anything else is 'number').
 * @param {number} n
 * @param {unknown} kind
 * @param {FormatContext | null} ctx
 */
export function formatNumber(n, kind, ctx) {
    const k = numberKind(kind);
    if (!ctx) return LEGACY[k](n);
    const { opts, suffix } = numberOptions(k, ctx);
    const unit = typeof ctx.options.unit === 'string' && ctx.options.unit.trim() ? ` ${ctx.options.unit.trim()}` : '';
    try {
        return `${numberFormat(ctx.app.language || undefined, opts).format(n)}${suffix}${unit}`;
    } catch {
        return LEGACY[k](n);
    }
}

/**
 * A tick/tooltip formatter for a chart's value axis: `valueFormat` is the chart's enum
 * ('number' | 'percent' | 'currency'). Non-finite input passes through untouched so labels and
 * strings still render. Without `ctx` (or with empty shapes) it is the formatter charts always had.
 * @param {string | undefined} valueFormat
 * @param {{ app?: unknown, options?: unknown } | null} [ctx]
 */
export function makeValueFormatter(valueFormat, ctx = null) {
    const context = ctx ? formatContext(ctx.app, ctx.options) : null;
    const kind = numberKind(valueFormat);
    return (/** @type {unknown} */ raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return raw == null ? '' : String(raw);
        return formatNumber(n, kind, context);
    };
}

// ── Dates ───────────────────────────────────────────────────────────

/** "2026-03-01": a calendar date with no time, which no time zone may move to another day. @param {unknown} v */
function isDateOnlyText(v) {
    if (typeof v !== 'string' || v.length !== 10 || v[4] !== '-' || v[7] !== '-') return false;
    for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (v[i] < '0' || v[i] > '9') return false;
    return true;
}

const FIELD_OPTS = Object.freeze({ hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });

/**
 * @param {Date} d
 * @param {string | undefined} timeZone
 * @returns {DateFields}
 */
function fieldsOf(d, timeZone) {
    if (!timeZone) {
        return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
    }
    /** @type {Record<string, number>} */
    const f = {};
    for (const part of dateFormat('en-US', { ...FIELD_OPTS, timeZone }).formatToParts(d)) {
        if (part.type !== 'literal') f[part.type] = Number(part.value);
    }
    return { year: f.year, month: f.month, day: f.day, hour: f.hour % 24, minute: f.minute, second: f.second };
}

/** @type {Readonly<Record<string, Intl.DateTimeFormatOptions>>} */
const NAME_OPTS = Object.freeze({
    monthLong: { month: 'long' }, monthShort: { month: 'short' },
    weekdayLong: { weekday: 'long' }, weekdayShort: { weekday: 'short' },
});

/**
 * @param {Date} d
 * @param {string} field
 * @param {string | undefined} locale
 * @param {string | undefined} timeZone
 */
function nameOf(d, field, locale, timeZone) {
    const tz = timeZone ? { timeZone } : {};
    if (field === 'dayPeriod') {
        const parts = dateFormat(locale, { hour: 'numeric', hour12: true, ...tz }).formatToParts(d);
        return parts.find((p) => p.type === 'dayPeriod')?.value || '';
    }
    return dateFormat(locale, { ...NAME_OPTS[field], ...tz }).format(d);
}

/** The app-level dateFormat when it is a pattern; a datetime gets the clock after it. @param {DateKind} kind @param {FormatContext} ctx */
function patternOf(kind, { app, options }) {
    const own = parseDatePattern(options.pattern);
    if (own) return own;
    if (typeof app.dateFormat !== 'string' || DATE_STYLES.includes(app.dateFormat)) return null;
    const appPattern = parseDatePattern(app.dateFormat);
    if (!appPattern || kind === 'date') return appPattern;
    return [...appPattern, { text: ' ' }, { token: 'HH' }, { text: ':' }, { token: 'mm' }];
}

/** @param {FormatContext} ctx */
function styleOf({ app, options }) {
    if (typeof options.dateStyle === 'string' && DATE_STYLES.includes(options.dateStyle)) return options.dateStyle;
    return typeof app.dateFormat === 'string' && DATE_STYLES.includes(app.dateFormat) ? app.dateFormat : null;
}

/**
 * @param {Date} d
 * @param {DateKind} kind
 * @param {FormatContext} ctx
 * @param {string | undefined} timeZone
 */
function writeDate(d, kind, ctx, timeZone) {
    const locale = ctx.app.language || undefined;
    const pattern = patternOf(kind, ctx);
    if (pattern) return renderDatePattern(pattern, fieldsOf(d, timeZone), (field) => nameOf(d, field, locale, timeZone));
    const tz = timeZone ? { timeZone } : {};
    const style = /** @type {Intl.DateTimeFormatOptions['dateStyle'] | null} */ (styleOf(ctx));
    if (style) return dateFormat(locale, kind === 'datetime' ? { dateStyle: style, timeStyle: 'short', ...tz } : { dateStyle: style, ...tz }).format(d);
    const opts = timeZone ? tz : undefined;
    return kind === 'datetime' ? d.toLocaleString(locale, opts) : d.toLocaleDateString(locale, opts);
}

/**
 * A date or a moment written as `kind` ('date' | 'datetime'), or null when `value` is no valid
 * date (the caller then shows the raw value, as it did before). `parsed` saves a second parse
 * when the caller already holds the Date.
 * @param {unknown} value
 * @param {DateKind} kind
 * @param {FormatContext | null} ctx
 * @param {Date} [parsed]
 * @returns {string | null}
 */
export function formatDate(value, kind, ctx, parsed) {
    const d = parsed instanceof Date ? parsed : new Date(/** @type {string | number | Date} */ (value));
    if (Number.isNaN(d.getTime())) return null;
    const k = kind === 'datetime' ? 'datetime' : 'date';
    if (!ctx) return LEGACY[k](d);
    // A calendar date stays on its day whatever zone the viewer or the app is in.
    const timeZone = k === 'date' && isDateOnlyText(value) ? 'UTC' : (ctx.app.timeZone || undefined);
    try {
        return writeDate(d, k, ctx, timeZone);
    } catch {
        return LEGACY[k](d);
    }
}

/**
 * The arguments for a caller that keeps its own toLocaleDateString options (a chart's time axis
 * picks them by the span it shows): the app's language and time zone, or exactly
 * `[undefined, opts]` without a format.
 * @param {unknown} app
 * @param {Intl.DateTimeFormatOptions} opts
 * @returns {[string | undefined, Intl.DateTimeFormatOptions]}
 */
export function localeDateArgs(app, opts) {
    const ctx = formatContext(app);
    if (!ctx) return [undefined, opts];
    return [ctx.app.language || undefined, ctx.app.timeZone ? { ...opts, timeZone: ctx.app.timeZone } : opts];
}

/**
 * THE FIELD HOOK. A data-model field may say how its values are shown (field.display
 * { currency, decimals, unit, dateStyle }, schema 3). A cell bound to such a field passes the
 * column's formatOptions and the field's display block through here; the column's own keys win.
 * Nothing calls it yet: the display block is not in this branch's data model.
 * @param {unknown} options
 * @param {unknown} display
 * @returns {FormatOptions | undefined}
 */
export function withFieldDisplay(options, display) {
    const own = isObject(options) ? /** @type {FormatOptions} */ (options) : undefined;
    if (!isObject(display)) return own;
    /** @type {FormatOptions} */
    const out = {};
    if (isCurrencyCode(display.currency)) out.currency = display.currency;
    if (isDecimals(display.decimals)) out.decimals = display.decimals;
    if (typeof display.unit === 'string' && display.unit.trim()) out.unit = display.unit.trim();
    if (typeof display.dateStyle === 'string' && DATE_STYLES.includes(display.dateStyle)) out.dateStyle = display.dateStyle;
    return { ...out, ...own };
}
