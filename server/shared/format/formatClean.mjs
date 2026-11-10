// @typecheck strict
/**
 * The two value-formatting shapes of an App Studio definition, cleaned key by key:
 *
 *   definition.format   { language, currency, currencyDecimals, dateFormat, timeZone }
 *                       how the whole app writes numbers and dates (definitionKeys/format.js)
 *   formatOptions       { currency, decimals, pattern, compact, percentScale }
 *                       one column, chart or stat (an `object` prop or item key, since 3)
 *
 * Every key is optional and nothing is ever filled in: an absent key keeps today's way of
 * writing that value, and a shape with no usable key is no shape at all (undefined). A value
 * that cannot be used is dropped with a repair, never guessed. Nothing here runs a regular
 * expression over author text: codes and patterns are read character by character, a language
 * tag and a time zone are asked of Intl itself.
 *
 * Shared by the server (canonicalize, validate) and the web editor through the generated copy in
 * agent-hub/src/shared/format/. The limits are LIMITS.MAX_FORMAT_* in
 * server/appStudio/componentSpecs/limits.js (formatLimits.test.js holds the two equal).
 */

import { isDatePattern, MAX_PATTERN_LEN } from './datePattern.mjs';

export const FORMAT_LIMITS = Object.freeze({
    MAX_DECIMALS: 10,
    MAX_PATTERN_LEN,
    MAX_LANGUAGE_LEN: 35,
    MAX_TIME_ZONE_LEN: 64,
});

/** Intl dateStyle words: a dateFormat that is one of these is a style, anything else a pattern. */
export const DATE_STYLES = Object.freeze(['short', 'medium', 'long', 'full']);
/** 'whole': 25 is written 25% (what a percent column always did). 'fraction': 0.25 is written 25%. */
export const PERCENT_SCALES = Object.freeze(['whole', 'fraction']);

export const APP_FORMAT_KEYS = Object.freeze(['language', 'currency', 'currencyDecimals', 'dateFormat', 'timeZone']);
export const FORMAT_OPTION_KEYS = Object.freeze(['currency', 'decimals', 'pattern', 'compact', 'percentScale']);

/** @typedef {(code: string, path: string, message: string) => void} Push */
/** @typedef {{ clean: (value: unknown) => unknown, hint: string }} KeyCleaner */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const noop = () => {};

/** @param {string} ch */
const isUpperLetter = (ch) => ch >= 'A' && ch <= 'Z';

/** @param {unknown} v @returns {v is string} */
export function isCurrencyCode(v) {
    if (typeof v !== 'string' || v.length !== 3) return false;
    for (const ch of v) if (!isUpperLetter(ch)) return false;
    return true;
}

/** "usd" and " USD " become "USD"; anything that is not three letters is refused. @param {unknown} v */
export function cleanCurrency(v) {
    if (typeof v !== 'string') return undefined;
    const code = v.trim().toUpperCase();
    return isCurrencyCode(code) ? code : undefined;
}

/** @param {unknown} v @returns {v is number} */
export function isDecimals(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= FORMAT_LIMITS.MAX_DECIMALS;
}

/** A whole number 0..MAX_DECIMALS, also when written as text ("2"). @param {unknown} v */
function cleanDecimals(v) {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return isDecimals(n) ? n : undefined;
}

/** A BCP 47 language tag in its canonical spelling ("en-us" → "en-US"), or undefined. @param {unknown} v */
export function cleanLanguage(v) {
    if (typeof v !== 'string') return undefined;
    const tag = v.trim();
    if (!tag || tag.length > FORMAT_LIMITS.MAX_LANGUAGE_LEN) return undefined;
    try {
        const [canonical] = Intl.getCanonicalLocales(tag);
        return typeof canonical === 'string' ? canonical : undefined;
    } catch {
        return undefined;
    }
}

/** An IANA time zone this engine knows ("Europe/Amsterdam", "UTC"), as written. @param {unknown} v */
export function cleanTimeZone(v) {
    if (typeof v !== 'string') return undefined;
    const zone = v.trim();
    if (!zone || zone.length > FORMAT_LIMITS.MAX_TIME_ZONE_LEN) return undefined;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return zone;
    } catch {
        return undefined;
    }
}

/** @param {unknown} v */
function cleanPattern(v) {
    if (typeof v !== 'string') return undefined;
    const text = v.trim();
    return isDatePattern(text) ? text : undefined;
}

/** A date style word or a pattern. @param {unknown} v */
function cleanDateFormat(v) {
    if (typeof v === 'string' && DATE_STYLES.includes(v.trim())) return v.trim();
    return cleanPattern(v);
}

const PATTERN_HINT = `must be a date pattern of at most ${MAX_PATTERN_LEN} characters built from yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h mm ss a, with other letters in single quotes (e.g. "dd-MM-yyyy")`;
const CURRENCY_HINT = 'must be a three-letter ISO 4217 code such as "USD"';
const DECIMALS_HINT = `must be a whole number from 0 to ${FORMAT_LIMITS.MAX_DECIMALS}`;

/** @type {Readonly<Record<string, KeyCleaner>>} */
const APP_FORMAT_CLEANERS = Object.freeze({
    language: { clean: cleanLanguage, hint: 'must be a language tag such as "en-US" or "nl-NL"' },
    currency: { clean: cleanCurrency, hint: CURRENCY_HINT },
    currencyDecimals: { clean: cleanDecimals, hint: DECIMALS_HINT },
    dateFormat: { clean: cleanDateFormat, hint: `must be ${DATE_STYLES.join(', ')} or a date pattern (${PATTERN_HINT.slice('must be a '.length)})` },
    timeZone: { clean: cleanTimeZone, hint: 'must be an IANA time zone such as "Europe/Amsterdam"' },
});

/** @type {Readonly<Record<string, KeyCleaner>>} */
const FORMAT_OPTION_CLEANERS = Object.freeze({
    currency: { clean: cleanCurrency, hint: CURRENCY_HINT },
    decimals: { clean: cleanDecimals, hint: DECIMALS_HINT },
    pattern: { clean: cleanPattern, hint: PATTERN_HINT },
    compact: { clean: (v) => (typeof v === 'boolean' ? v : undefined), hint: 'must be true or false' },
    percentScale: { clean: (v) => (typeof v === 'string' && PERCENT_SCALES.includes(v) ? v : undefined), hint: `must be ${PERCENT_SCALES.join(' or ')}` },
});

/**
 * The cleaned object, keys in the table's order, or undefined when nothing usable is left.
 * @param {unknown} raw
 * @param {Readonly<Record<string, KeyCleaner>>} cleaners
 * @param {Push} push
 * @param {string} path
 * @param {string} code
 */
function cleanShape(raw, cleaners, push, path, code) {
    if (!isObject(raw)) {
        push(`${code}.invalid`, path, `${path} must be an object — dropped.`);
        return undefined;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, { clean, hint }] of Object.entries(cleaners)) {
        const value = raw[key];
        if (value === undefined || value === null) continue;
        const cleaned = clean(value);
        if (cleaned === undefined) push(`${code}.invalid`, `${path}.${key}`, `${key} ${hint} — dropped.`);
        else out[key] = cleaned;
    }
    const unknown = Object.keys(raw).filter((key) => !Object.hasOwn(cleaners, key));
    if (unknown.length) push(`${code}.unknown_key`, path, `Dropped unknown keys: ${unknown.join(', ')}. Legal keys: ${Object.keys(cleaners).join(', ')}.`);
    return Object.keys(out).length ? out : undefined;
}

/**
 * definition.format, cleaned: undefined drops the key.
 * @param {unknown} raw
 * @param {Push} [push]
 * @param {string} [path]
 */
export function cleanAppFormat(raw, push = noop, path = 'format') {
    return cleanShape(raw, APP_FORMAT_CLEANERS, push, path, 'format');
}

/**
 * A formatOptions object, cleaned: undefined drops the key.
 * @param {unknown} raw
 * @param {Push} [push]
 * @param {string} [path]
 */
export function cleanFormatOptions(raw, push = noop, path = 'formatOptions') {
    return cleanShape(raw, FORMAT_OPTION_CLEANERS, push, path, 'formatOptions');
}

/**
 * What is wrong with a value that should already be clean (the validator's question): every
 * repair the cleaner would make, as a sentence. Empty for a clean value.
 * @param {unknown} value
 * @param {(raw: unknown, push: Push, path: string) => unknown} cleaner
 * @param {string} path
 * @returns {{ path: string, message: string }[]}
 */
export function shapeProblems(value, cleaner, path) {
    /** @type {{ path: string, message: string }[]} */
    const problems = [];
    const cleaned = cleaner(value, (_code, at, message) => problems.push({ path: at, message }), path);
    if (!problems.length && JSON.stringify(cleaned) !== JSON.stringify(value)) {
        problems.push({ path, message: `${path} is not in its canonical form — run the definition through canonicalize.` });
    }
    return problems;
}
